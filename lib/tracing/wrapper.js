const locate = require('./locate')
const trace = require('./trace')

/**
 *
 * @param {Function} fn
 * @param {Object} options
 * @param {Function} options.wrapper
 * @param {String} options.phase
 * @param {String} options.event
 * @param {String} options.loggerName
 */
function wrap(fn, options) {
  if (!fn.__wrapped) {
    if (!options.no_locate && !process.env.NO_LOCATE) {
      let __location
      locate(fn).then(location => {
        __location = location
      })
      Object.defineProperty(fn, '__location', {
        get: function () {
          return __location
        }
      })
    }

    const original = fn
    let wrapped = options.wrapper
      ? options.wrapper
      : function wrapper(...args) {
          return trace({ event: options.event || fn.name, phase: options.phase || '' }, original, this, args, options)
        }
    defineProperty(wrapped, '__original', original)
    defineProperty(wrapped, '__unwrap', function () {
      if (wrapped.__wrapped) {
        wrapped = original
        wrapped.__wrapped = false
      }
    })
    defineProperty(wrapped, '__wrapped', true)
    fn = wrapped
  }

  return fn
}

function defineProperty(obj, name, value) {
  // eslint-disable-next-line no-prototype-builtins
  const enumerable = !!obj[name] && obj.propertyIsEnumerable(name)
  Object.defineProperty(obj, name, {
    configurable: true,
    enumerable: enumerable,
    writable: true,
    value: value
  })
}

module.exports = wrap
