const trace = require('./trace')

/**
 *
 * @param {Function} func
 * @param {Object} options
 * @param {Function} options.wrapper
 * @param {String} options.phase
 * @param {String} options.event
 * @param {String} options.loggerName
 */
function wrap(func, options) {
  if (!func.__wrapped) {
    const original = func
    let wrapped = options.wrapper
      ? options.wrapper
      : function wrapper(...args) {
          return trace({ event: options.event || func.name, phase: options.phase || '' }, original, this, args, options)
        }
    defineProperty(wrapped, '__original', original)
    defineProperty(wrapped, '__unwrap', function () {
      if (wrapped.__wrapped) {
        wrapped = original
        wrapped.__wrapped = false
      }
    })
    defineProperty(wrapped, '__wrapped', true)
    func = wrapped
  }
  return func
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
