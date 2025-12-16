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

  const meter = metrics.getMeter('@cap-js/telemetry:db-pool')

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
    description: 'The number of maximum number of resources allowed by pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  max.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return unobserve(tenant)
      const max = pool.max ?? pool.options?.max
      if (max) result.observe(max, { 'sap.tenancy.tenant_id': tenant })
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
      const min = pool.min ?? pool.options?.min
      if (min) result.observe(min, { 'sap.tenancy.tenant_id': tenant })
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
      const spare = pool.spareResourceCapacity ?? pool.options?.max - pool.size - pool.pending
      if (Number.isInteger(spare)) result.observe(spare, { 'sap.tenancy.tenant_id': tenant })
    })
  })
}

module.exports = () => {
  if (!cds.env.requires.telemetry.metrics?._db_pool) return

  cds.on('connect', function (srv) {
    if (!_kinds.has(srv.kind)) return

    if (_initialized.has(srv.name)) return
    _initialized.add(srv.name)

    let pools
    srv.after('BEGIN', async function (_, req) {
      const pool = this.dbc._pool || this.pool
      if (!pool) return

      if (!pools) init((pools = new Map()))

      const tenant = cds.context?.tenant
      if (!pools.has(tenant) && pools.get(undefined) !== pool) {
        tenant && LOG._debug && LOG.debug(`Start observing pool for tenant "${tenant}"`)
        pools.set(tenant, pool)
      }
    })
  })
}
