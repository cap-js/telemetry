const { SimpleLogRecordProcessor } = require('@opentelemetry/sdk-logs')

class MySimpleLogRecordProcessor extends SimpleLogRecordProcessor {
  onEmit(logRecord) {
    return super.onEmit(logRecord)
  }
}

module.exports = { MySimpleLogRecordProcessor }
