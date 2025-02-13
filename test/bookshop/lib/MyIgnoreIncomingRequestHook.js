module.exports = req => {
  return req.url.startsWith('/odata/v4/admin/Authors') || req.url.match(/\/Books\(252\)/)
}
