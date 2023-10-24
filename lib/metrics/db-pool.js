const cds = require('@sap/cds')
const LOG = cds.log('otel', { label: 'otel:metrics' })

// REVISIT: instanceof cds.DatabaseService doesn't work with @cap-js databases
const _kinds = new Set(['sqlite', 'hana', 'postgres'])

const _initialized = new Set()

function init(pools) {
  const { metrics, ValueType } = require('@opentelemetry/api')

  const meter = metrics.getMeter(`${cds.env.requires.otel.trace.name}-meter`)

  const borrowed = meter.createObservableGauge('db.pool.borrowed', {
    description: 'The number of resources that are currently acquired by userland code',
    unit: 'each',
    valueType: ValueType.INT
  })
  const pending = meter.createObservableGauge('db.pool.pending', {
    description: 'The number of callers waiting to acquire a resource',
    unit: 'each',
    valueType: ValueType.INT
  })
  const size = meter.createObservableGauge('db.pool.size', {
    description: 'The number of resources in the pool regardless of whether they are free or in use',
    unit: 'each',
    valueType: ValueType.INT
  })
  const available = meter.createObservableGauge('db.pool.available', {
    description: 'The number of unused resources in the pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  const max = meter.createObservableGauge('db.pool.max', {
    description: 'The number of maxixmum number of resources allowed by pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  const min = meter.createObservableGauge('db.pool.min', {
    description: 'The number of minimum number of resources allowed by pool',
    unit: 'each',
    valueType: ValueType.INT
  })
  const spareResourceCapacity = meter.createObservableGauge('db.pool.spareResourceCapacity', {
    description: 'The number of resources that the pool can manage/ create',
    unit: 'each',
    valueType: ValueType.INT
  })

  borrowed.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
      result.observe(pool.borrowed, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  pending.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
      result.observe(pool.pending, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  size.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
      result.observe(pool.size, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  available.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
      result.observe(pool.available, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  max.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
      result.observe(pool.max, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  min.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
      result.observe(pool.min, { 'sap.tenancy.tenant_id': tenant })
    })
  })
  spareResourceCapacity.addCallback(result => {
    pools.forEach((pool, tenant) => {
      if (!pool) return LOG._warn && LOG.warn('Pool not defined for tenant', tenant)
      result.observe(pool.spareResourceCapacity, { 'sap.tenancy.tenant_id': tenant })
    })
  })
}

module.exports = () => {
  // REVISIT: should probably be cds.on('connect') with check if a database service
  cds.on('connect', function (srv) {
    if (!_kinds.has(srv.kind)) return

    if (_initialized.has(srv.name)) return
    _initialized.add(srv.name)

    let pools
    srv.after('BEGIN', async function (_, req) {
      if (!this.dbc._pool) return

      if (!pools) init((pools = new Map()))
      if (!pools.has(req.tenant)) {
        LOG._debug && LOG.debug('Adding pool to map for tenant', req.tenant)
        pools.set(req.tenant, this.dbc._pool)
      }
    })
  })
}
