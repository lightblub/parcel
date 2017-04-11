'use strict'
const path = require('path')
const fs = require('fs')
const {Readable} = require('stream')

module.exports = (file, cb) =>
  fs.realpath(file, (e, file) => e ? cb(e) : new Parcel().bundle(file, cb))

class RequireError extends Error {}

module.exports.RequireError = RequireError

class Parcel {
  constructor() {
    this.files = new Map
    this.mains = new Map
    this.cache = new Map
  }
  bundle(mod, cb) {
    this.resolve(null, mod, (e, file) => e ? cb(e) :
      this.include(file, e => {
        if (e) return cb(e)
        this.main = file
        cb(null, this)
      }))
  }
  dependencies() {return Array.from(this.files.keys())}
  js(end) {
    const js = new Readable
    const it = this.jsGen(end)
    js._read = () => js.push(it.next().value)
    return js
  }
  *jsGen(end) {
    yield JS_START
    for (const [mod, main] of this.mains) {
      yield `\n  Parcel.mains[${this.jsPath(mod)}] = ${this.jsPath(main)}`
    }
    for (const [file, info] of this.sortedFiles()) {
      const id = this.namePath(file)
      const prefix = file.endsWith('.json') ? 'module.exports =' : ''
      const deps = this.stringifyDeps(info.deps)
      const filename = this.jsPath(file)
      yield `\n  `
      if (info.raw) {
        yield `var ${id} = `
        yield JSON.stringify(info.source)
        yield `;`
      } else {
        yield `function ${id}(module, exports, require) {${prefix}\n`
        yield info.source
        yield `}`
      }
      yield `\n  Parcel.files[${filename}] = ${id}; ${id}.raw = ${info.raw}; ${id}.deps = ${deps}; ${id}.filename = ${filename};`
    }
    const main = this.namePath(this.main)
    yield `\n  Parcel.main = ${main}; Parcel.makeRequire(null)()`
    yield `\n  if (typeof module !== 'undefined') module.exports = Parcel.main.module && Parcel.main.module.exports`
    yield JS_END
    if (end) yield end
    yield null
  }
  sortedFiles() {
    return this._sortedFiles || (this._sortedFiles = [...this.files].sort((a, b) => a[0].localeCompare(b[0])))
  }
  namePath(p) {
    return 'file_' + p.replace(/\W/g, s => {
      const n = s.charCodeAt(0).toString(16)
      return '$' + '0000'.slice(n.length) + n
    })
  }
  jsPath(p) {
    return JSON.stringify(p[0] === '/' ? p : '/' + p.replace(/\\/g, '/'))
  }
  stringifyDeps(m) {
    let s = '{'
    let comma = false
    for (const [k, v] of m) {
      if (comma) s += ','
      s += JSON.stringify(k)
      s += ':'
      s += this.namePath(v)
      comma = true
    }
    s += '}'
    return s
    // const o = Object.create(null)
    // for (const [k, v] of m) {
    //   o[k] = v
    // }
    // return JSON.stringify(o)
    // return 'new Map(' + JSON.stringify(Array.from(m)) + ')'
  }
  map(end = '', dir = path.dirname(this.main)) {
    const sortedFiles = this.sortedFiles()
    const map = {
      version: 3,
      file: '',
      sourceRoot: '',
      sources: Array.from(sortedFiles, a => a[0])
        .map(f => path.relative(dir, f)),
      sourcesContent: Array.from(sortedFiles, a => a[1].source),
      names: [],
    }
    const prefix = lineCount(JS_START) + this.mains.size
    const mappings = Array(prefix)
    let index = null
    let line = 0
    for (const [file, {source}] of sortedFiles) {
      mappings.push(undefined)
      let first = true
      for (let i = lineCount(source); i--;) {
        mappings.push('A' + (first ? (index == null ? 'AAA' : 'C' + vlq(-line) + 'A') : 'ACA'))
        if (first) line = 0
        else ++line
        first = false
      }
      ++index
    }
    mappings.push(...Array(2 + lineCount(JS_END + end) - 1))
    map.mappings = mappings.join(';')
    return JSON.stringify(map)
  }
  include(file, cb, raw) {
    if (!file || this.files.has(file)) return process.nextTick(cb)
    fs.readFile(file, {encoding: 'utf8'}, (e, js) => {
      if (e) return cb(e)
      if (js[0] === '#' && js[1] === '!' && !raw) {
        js = '//' + js.slice(2)
      }
      const info = { source: js, raw: !!raw }
      this.files.set(file, info)
      if (raw) {
        info.deps = new Map
        return cb()
      }
      const deps = new Set
      let x
      while (x = REQUIRE_RE.exec(js)) {
        deps.add(JSON.parse('"' + (x[1] || x[2] || '') + '"'))
      }
      while (x = REQUIRE_RAW_RE.exec(js)) {
        deps.add(JSON.parse('"' + (x[1] || x[2] || '') + '"'))
      }
      const depsArr = Array.from(deps)
      map(depsArr, (d, cb) => this.resolve(file, d, cb), (e, resolved) => {
        if (e) return cb(e)
        info.deps = new Map
        for (let i = depsArr.length; i--;) {
          info.deps.set(depsArr[i], resolved[i])
        }
        const files = new Set(resolved.filter(x => x))
        map(files, (f, cb) => this.include(f, cb, true), e => cb(e))
      })
    })
  }
  resolve(parent, name, cb) {
    const nope = () =>
      cb(new RequireError(`Could not resolve module name: ${name} in ${parent}`))
    if (name[0] === '.' || name[0] === '/') {
      const p = name[0] === '.' ? path.resolve(parent, '..', name) : name
      this.resolvePathOrModule(p, (e, file) => e ? nope() : cb(null, file))
    } else if (parent) {
      if (CORE_MODULES.has(name)) return process.nextTick(cb, null, null)
      let p = parent
      const next = () => {
        const n = path.dirname(p)
        if (n === p) return nope()
        p = n
        if (path.basename(p) === 'node_modules') return next()
        const k = path.join(p, 'node_modules', name)
        this.resolvePathOrModule(k, (e, file) => e ? next() : cb(null, file))
      }
      process.nextTick(next)
    } else process.nextTick(cb, new RequireError('Main module must be a file path'))
  }
  resolvePathOrModule(base, cb) {
    const m = this.mains.get(base)
    if (m) return process.nextTick(cb, null, m)
    const pkg = path.join(base, 'package.json')
    fs.readFile(pkg, (e, j) => {
      if (j) {
        const main = JSON.parse(j).main
        if (main) {
          const real = path.resolve(base, main)
          return this.resolvePath(real, (e, file) => {
            if (e) return cb(new Error)
            this.mains.set(base, file)
            cb(null, file)
          })
        }
      }
      this.resolvePath(base, cb)
    })
  }
  resolvePath(base, cb) {
    const indexJS = path.join(base, 'index.js')
    const indexJSON = path.join(base, 'index.json')
    this.exists(base, t => t ? cb(null, base) :
    this.exists(base+'.js', t => t ? cb(null, base+'.js') :
    this.exists(indexJS, t => t ? cb(null, indexJS) :
    this.exists(base+'.json', t => t ? cb(null, base+'.json') :
    this.exists(indexJSON, t => t ? cb(null, indexJSON) :
    cb(new Error))))))
  }
  exists(file, cb) {
    const t = this.cache.get(file)
    if (t != null) return process.nextTick(cb, t)
    fs.stat(file, (e, s) => {
      const t = !e && s.isFile()
      this.cache.set(file, t)
      cb(t)
    })
  }
}

const REQUIRE_RE = /\brequire\s*\(\s*(?:'((?:[^'\n]+|\\[^])*)'|"((?:[^"\n]+|\\[^])*)")\s*\)/g
const REQUIRE_RAW_RE = /\brequire\s*\.raw\s*\(\s*(?:'((?:[^'\n]+|\\[^])*)'|"((?:[^"\n]+|\\[^])*)")\s*\)/g

const CORE_MODULES = new Set(['assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https', 'net', 'os', 'path', 'punycode', 'querystring', 'readline', 'stream', 'string_decoder', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'zlib'])

const JS_START = '~' + function(global) {
  const Parcel = {}
  Parcel.baseRequire = typeof require !== "undefined" ? require : n => {
    throw new Error(`Could not resolve module name: ${n}`)
  }
  Parcel.modules = {}
  Parcel.files = {}
  Parcel.mains = {}
  Parcel.resolve = (base, then) => {
    base = base.split('/')
    base.shift()
    for (const p of then.split('/')) {
      if (p === '..') base.pop()
      else if (p !== '.') base.push(p)
    }
    return '/' + base.join('/')
  }
  Parcel.Module = function Module(filename, parent) {
    this.filename = filename
    this.id = filename
    this.loaded = false
    this.parent = parent
    this.children = []
    this.exports = {}
  }
  Parcel.makeRequire = self => {
    let parts
    const require = m => {
      let fn = self ? require.deps[m] : Parcel.main
      if (fn === undefined) {
        const filename = require.resolve(m)
        fn = filename !== null ? Parcel.files[filename] : null
      }
      if (fn === null) return Parcel.baseRequire(m)
      if (fn.module) return fn.module.exports
      const module = new Parcel.Module(fn.filename, self)
      fn.module = module
      module.require = Parcel.makeRequire(module)
      module.require.deps = fn.deps
      module.require.main = self ? self.require.main : module
      if (self) self.children.push(module)
      if (fn.raw || typeof fn === 'string') return fn
      fn(module, module.exports, module.require)
      module.loaded = true
      return module.exports
    }
    require.deps = {}
    require.main = self
    require.resolve = n => {
      if (!self) return n
      if (n[0] === '.' || n[0] === '/') {
        const p = resolvePath(n[0] === '.' ? Parcel.resolve(self.filename, '../'+n) : n)
        if (p) return p
      } else {
        if (!parts) {
          parts = self ? self.filename.split('/') : []
          parts.shift()
        }
        const p = parts.slice()
        while (p.length) {
          p.pop()
          if (p[p.length - 1] === 'node_modules') continue
          const r = resolvePath('/' + p.join('/') + '/node_modules/' + n)
          if (r) return r
        }
      }
      return null
    }
    const resolvePath = b => {
      const m = Parcel.mains[b]
      if (m) return m
      if (Parcel.files[b+'/index.js']) return b+'/index.js'
      if (Parcel.files[b+'/index.json']) return b+'/index.json'
      if (Parcel.files[b]) return b
      if (Parcel.files[b+'.js']) return b+'.js'
      if (Parcel.files[b+'.json']) return b+'.json'
    }
    return require
  }
}.toString().slice(0, -1)
const JS_END = '\n}(typeof global !== "undefined" ? global : typeof window !== "undefined" ? window : this)\n'

function map(it, fn, cb) {
  let i = 0, done = 0, err = false
  const result = []
  for (const x of it) {
    const k = i++
    fn(x, (e, y) => {
      if (err) return
      if (e) return err = true, cb(e)
      result[k] = y
      if (++done === length) return cb(null, result)
    })
  }
  const length = i
  if (!length) process.nextTick(cb, null, result)
}
function lineCount(s) {
  const m = s.match(LINE_RE)
  return m ? m.length + 1 : 1
}
const LINE_RE = /\n/g

function vlq(n) {
  const sign = n < 0
  if (sign) n = -n
  let y = (n & 0xf) << 1 | sign
  let r = n >> 4
  let s = ''
  while (r) {
    y |= 0x20
    s += B64[y]
    y = r & 0x1f
    r >>= 5
  }
  return s + B64[y]
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
