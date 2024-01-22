const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { metrics, ValueType } = require('@opentelemetry/api')

const _kinds = new Set(['sqlite', 'hana', 'postgres'])
const _initialized = new Set()

function init(pools) {
  const unobserve = tenant => {
    LOG._warn && LOG.warn(`Pool for tenant "${tenant}" no longer exists`)
    pools.delete(tenant)
  }

  // REVISIT: is "-meter" appendix the standard approach?
  const meter = metrics.getMeter(`${cds._telemetry.name}-meter`)

  const borrowed = meter.createObservableGauge('db.pool.borrowed', {
    description: 'The number of resources that are currently acquired by userland code',
    unit: 'each',
    valueType: ValueType.INT
  })
  borrowed.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return unobserve(tenant)
      result.observe(pool.borrowed, { 'sap.tenancy.tenant_id': tenant })
    })
  })

  const pending = meter.createObservableGauge('db.pool.pending', {
    description: 'The number of callers waiting to acquire a resource',
    unit: 'each',
    valueType: ValueType.INT
  })
  pending.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return unobserve(tenant)
      result.observe(pool.pending, { 'sap.tenancy.tenant_id': tenant })
    })
  })

  const size = meter.createObservableGauge('db.pool.size', {
    description: 'The number of resources in the pool regardless of whether they are free or in use',
    unit: 'each',
    valueType: ValueType.INT
  })
  size.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return unobserve(tenant)
      result.observe(pool.size, { 'sap.tenancy.tenant_id': tenant })
    })
  })

  const available = meter.createObservableGauge('db.pool.available', {
    description: 'The number of unused resources in the pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  available.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return unobserve(tenant)
      result.observe(pool.available, { 'sap.tenancy.tenant_id': tenant })
    })
  })

  const max = meter.createObservableGauge('db.pool.max', {
    description: 'The number of maxixmum number of resources allowed by pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  max.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return unobserve(tenant)
      result.observe(pool.max, { 'sap.tenancy.tenant_id': tenant })
    })
  })

  const min = meter.createObservableGauge('db.pool.min', {
    description: 'The number of minimum number of resources allowed by pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  min.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return unobserve(tenant)
      result.observe(pool.min, { 'sap.tenancy.tenant_id': tenant })
    })
  })

  const spareResourceCapacity = meter.createObservableGauge('db.pool.spareResourceCapacity', {
    description: 'The number of resources that the pool can manage/ create',
    unit: 'each',
    valueType: ValueType.INT
  })
  spareResourceCapacity.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return unobserve(tenant)
      result.observe(pool.spareResourceCapacity, { 'sap.tenancy.tenant_id': tenant })
    })
  })
}

module.exports = () => {
  cds.on('connect', function (srv) {
    if (!_kinds.has(srv.kind)) return

    if (_initialized.has(srv.name)) return
    _initialized.add(srv.name)

    let pools
    srv.after('BEGIN', async function (_, req) {
      const pool = this.dbc._pool || this.pool
      if (!pool) return

      if (!pools) init((pools = new Map()))

      if (!pools.has(req.tenant) && pools.get(undefined) !== pool) {
        req.tenant && LOG._debug && LOG.debug(`Start observing pool for tenant "${req.tenant}"`)
        pools.set(req.tenant, pool)
      }
    })
  })
}
