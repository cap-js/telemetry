const cds = require('@sap/cds'),
  LOG = cds.log('pooling')
const { metrics, ValueType } = require('@opentelemetry/api')

module.exports = () => {
  const pools = new Map()
  cds.on('served', async () => {
    const db = await cds.connect.to('db')
    db.after('BEGIN', async function (res, req) {
      LOG.debug('Add pool to weakmap for tenant', req.tenant)
      LOG.debug('Pool is set', !!this.dbc._pool)
      if (this.dbc._pool) pools.set(req.tenant, this.dbc._pool)
    })

    const meter = metrics.getMeter(`${cds.env.trace.name}-meter`)
    const borrowedPool = meter.createObservableGauge('db.pool.borrowed', {
      description: 'The amount of currently borrowed connections of the db pool',
      unit: 'each',
      valueType: ValueType.INT
    })
    const pendingPool = meter.createObservableGauge('db.pool.pending', {
      description: 'The amount of currently pending connections of the db pool',
      unit: 'each',
      valueType: ValueType.INT
    })
    const sizePool = meter.createObservableGauge('db.pool.size', {
      description: 'The size of the db pool',
      unit: 'each',
      valueType: ValueType.INT
    })
    const availablePool = meter.createObservableGauge('db.pool.available', {
      description: 'The amount of currently available connections in the db pool',
      unit: 'each',
      valueType: ValueType.INT
    })
    const maxPool = meter.createObservableGauge('db.pool.max', {
      description: 'The maximal size of the db pool',
      unit: 'each',
      valueType: ValueType.INT
    })
    const minPool = meter.createObservableGauge('db.pool.min', {
      description: 'The minimum size of the db pool',
      unit: 'each',
      valueType: ValueType.INT
    })

    borrowedPool.addCallback(result => {
      pools.forEach((pool, tenant) => {
        if (!pool) {
          LOG.warn('Pool not defined for tenant', tenant)
          return
        }
        result.observe(pool.borrowed, { 'sap.tenancy.tenant_id': tenant })
      })
    })
    pendingPool.addCallback(result => {
      pools.forEach((pool, tenant) => {
        if (!pool) {
          LOG.warn('Pool not defined for tenant', tenant)
          return
        }
        result.observe(pool.pending, { 'sap.tenancy.tenant_id': tenant })
      })
    })
    sizePool.addCallback(result => {
      pools.forEach((pool, tenant) => {
        if (!pool) {
          LOG.warn('Pool not defined for tenant', tenant)
          return
        }
        result.observe(pool.size, { 'sap.tenancy.tenant_id': tenant })
      })
    })
    availablePool.addCallback(result => {
      pools.forEach((pool, tenant) => {
        if (!pool) {
          LOG.warn('Pool not defined for tenant', tenant)
          return
        }
        result.observe(pool.available, { 'sap.tenancy.tenant_id': tenant })
      })
    })
    maxPool.addCallback(result => {
      pools.forEach((pool, tenant) => {
        if (!pool) {
          LOG.warn('Pool not defined for tenant', tenant)
          return
        }
        result.observe(pool.max, { 'sap.tenancy.tenant_id': tenant })
      })
    })
    minPool.addCallback(result => {
      pools.forEach((pool, tenant) => {
        if (!pool) {
          LOG.warn('Pool not defined for tenant', tenant)
          return
        }
        result.observe(pool.min, { 'sap.tenancy.tenant_id': tenant })
      })
    })
  })
}
