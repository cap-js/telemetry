module.exports = name => {
  name = Array.isArray(name) ? name[0] : name
  try {
    return require(name)
  } catch (e) {
    e.message = `Cannot find module '${name}'. Make sure to install it with 'npm i ${name}'\n` + e.message
    throw e
  }
}
