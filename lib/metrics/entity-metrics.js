const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { metrics } = require('@opentelemetry/api')

const METER = '@cap-js/telemetry:business-metrics';

//Store counters to avoid recreating it for the same entity-event
const counters = new Map();

function getOrCreateCounter(counterName, args) {
    if (counters.has(counterName)) {
        return counters.get(counterName);
    }
    const meter = metrics.getMeter(METER);
    let counter;
    counter = meter.createCounter(counterName, args);
    counters.set(counterName, counter);
    return counter;
}

function increaseCounter(counterName, args) {
    const counter = getOrCreateCounter(counterName);
    counter.add(1, args);
}

async function createObservableGauge(entity, fieldToObserve, key) {
    const meter = metrics.getMeter(METER);
    const bookStock = meter.createObservableGauge('book_stock', {
        description: 'The current stock of books'
      })
      bookStock.addCallback(async (result) => {
        const tx = cds.transaction();
        const books = await tx.run(SELECT.from(entity));
    
        // Iterate over the books and report their fields' stock values
        books.forEach(book => {
            fieldToObserve.forEach(field => {
                result.observe(book[field], { "entity": entity.name, "key": book[key] });
            });
        });
        
        await tx.rollback();
      })
}

module.exports = {
    increaseCounter,
    createObservableGauge
}