let _startup = true

const cds = require('@sap/cds')
if (!(cds.cli?.command in { '': 1, serve: 1, run: 1 })) _startup = false

// cds add XXX currently also has cli.command === ''
const i = process.argv.indexOf('add')
if (i > 1 && process.argv[i - 1].match(/cds(\.js)?$/)) _startup = false

if (!!process.env.NO_TELEMETRY && process.env.NO_TELEMETRY !== 'false') _startup = false

if(cds.requires.telemetry.metrics.enableBusinessMetrics) {
    //business metrics handling

    cds.once("served", async () => {
        // Go through all services
        for (let srv of cds.services) {
            // Go through all entities of that service
            for (let entity of srv.entities) { 

                await handleCounterAnnotationOnEntity(entity, srv);
                await handleGaugeAnnotation(entity);
                
                //bound actions
                if (entity.actions) {
                    for (let boundAction of entity.actions) {
                        await handleCounterAnnotationOnBoundAction(boundAction, srv)
                    }
                }
            }

            //unbound actions
            for (let action of srv.actions) {
                await handleCounterAnnotationOnUnboundAction(action, srv);
            }
        }    
    });
}

function getLabels(attributes, req) {
    let labels = {};

    if (attributes) {
        attributes.forEach((attribute) => {
            switch (attribute['=']) {
                case 'user':
                    labels.user = req.user.id;
                    break;
                case 'tenant':
                    labels.tenant = req.authInfo?.getSubdomain();
                    break;
            }
        });
    }

    return labels;
}

async function handleCounterAnnotationOnEntity(entity, srv) {
    if (entity['@Counter.attributes']) {
        // Register after handler for all events and create counter with given attributes
        for (let event of events) {
            srv.after(event, entity, async (req) => {
                increaseCounter(`${entity.name}_${event}_total`, getLabels(entity['@Counter.attributes'], req));
                // createCounterMetrics({entity: entity.name, event: event, labels: getLabels(event, req)})
            });
        }
    } 

    else if (entity['@Counter']) {
        // User annotated with only events, may or may not have specified attributes
        if (entity['@Counter'].length > 0) {
            // Register after handler for only those events as annotated by user
            for (let event of entity['@Counter']) {
                srv.after(event.event, entity, async (_, req) => {
                    let attributes = event.attributes ? event.attributes : userAttributes;
                    increaseCounter(`${entity.name}_${event.event}_total`, getLabels(attributes, req));
                    // createCounterMetrics({entity: entity.name, event: event['='], labels: getLabels(event, req)})
                });
            }
        } else {
            // User annotated without specifying the event and attributes
            for (let event of events) {
                srv.after(event, entity, async (req) => {
                    increaseCounter(`${entity.name}_${event}_total`, getLabels(userAttributes, req));
                    // createCounterMetrics({entity: entity.name, event: event, labels: getLabels([], req)})
                });
            }
        }
    }
}

async function handleCounterAnnotationOnBoundAction(boundAction, srv) {
    if (boundAction['@Counter'] || boundAction['@Counter.attributes']) {
        let attributes = boundAction['@Counter'] ? userAttributes : boundAction['@Counter.attributes'];
        // Extract name from action.name => CatalogService.purchaseBook -> purchaseBook
        const actionName = boundAction.name.split('.').pop();

        srv.after(actionName, entity, async (_, req) => {
            increaseCounter(`${boundAction.parent}_${boundAction.name}_total`, getLabels(attributes, req));
            // createCounterMetrics({isAction: true, action: `${boundAction.parent}-${boundAction.name}`, actionResponse: res})
        });
    }
}

async function handleCounterAnnotationOnUnboundAction(action, srv) {
    if (action['@Counter'] || action['@Counter.attributes']) {
        let attributes = action['@Counter'] ? userAttributes : action['@Counter.attributes'];

        // Extract name from action.name => CatalogService.purchaseBook -> purchaseBook
        const actionName = action.name.split('.').pop();

        srv.after(actionName, async (_, req) => {
            increaseCounter(`${action.name}_total`, getLabels(attributes, req));
            // createCounterMetrics({isAction: true, action: action.name, actionReq: req})
        });
    }
}

async function handleGaugeAnnotation(entity) {
    if (entity['@Gauge.observe' && '@Gauge.key']) {
        await createObservableGauge(entity, entity['@Gauge.observe'], entity['@Gauge.key']);
    }
}

if (_startup) require('./lib')()
