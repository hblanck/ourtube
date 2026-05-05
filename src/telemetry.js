'use strict';

/**
 * OpenTelemetry bootstrap for OurTube.
 *
 * Initialised BEFORE any other require()s in server.js.
 *
 * Configuration via environment variables:
 *   OTEL_EXPORTER_OTLP_ENDPOINT   - e.g. http://localhost:4318 (disable if not set)
 *   OTEL_SERVICE_NAME              - defaults to 'ourtube'
 *   OTEL_SDK_DISABLED              - set to 'true' to explicitly disable
 */

const { diag, DiagConsoleLogger, DiagLogLevel, metrics, trace } = require('@opentelemetry/api');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

let sdkStarted = false;
let sdk = null;
let _meter = null;

// Shared counters available even without an OTLP endpoint.
const _localCounters = {
  httpRequests: 0,
  scansRun: 0,
  bytesStreamed: 0,
  streamRequests: 0,
};

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '';
const disabled = process.env.OTEL_SDK_DISABLED === 'true';
const enabled = !disabled && Boolean(otlpEndpoint);

function init() {
  if (sdkStarted) return;
  sdkStarted = true;

  if (!enabled) {
    console.log(`[telemetry] OpenTelemetry disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to enable)`);
    return;
  }

  try {
    if (process.env.OTEL_LOG_LEVEL === 'debug') {
      diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
    }

    const packageJson = require('../package.json');
    const serviceName = process.env.OTEL_SERVICE_NAME || 'ourtube';

    const traceExporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });
    const metricExporter = new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` });

    sdk = new NodeSDK({
      resource: new Resource({
        [SEMRESATTRS_SERVICE_NAME]: serviceName,
        [SEMRESATTRS_SERVICE_VERSION]: packageJson.version || '0.0.0',
      }),
      traceExporter,
      metricReader: new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60_000,
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
        }),
      ],
    });

    sdk.start();
    console.log(`[telemetry] OpenTelemetry started. OTLP endpoint: ${otlpEndpoint} service: ${serviceName}`);

    // Expose a meter for custom metrics
    _meter = metrics.getMeter(serviceName);
    const reqCounter = _meter.createCounter('ourtube.http.requests.total', { description: 'Total HTTP requests' });
    const scanCounter = _meter.createCounter('ourtube.scans.total', { description: 'Total library scans completed' });
    const bytesCounter = _meter.createCounter('ourtube.stream.bytes_sent', { description: 'Total bytes sent via streams' });
    const streamCounter = _meter.createCounter('ourtube.stream.requests.total', { description: 'Total stream requests' });

    // Attach the meter counters so callers can increment them
    _localCounters._otel = { reqCounter, scanCounter, bytesCounter, streamCounter };

    process.on('SIGTERM', () => {
      sdk.shutdown().then(() => console.log('[telemetry] OpenTelemetry SDK shut down')).catch(console.error);
    });
  } catch (err) {
    console.error('[telemetry] Failed to start OpenTelemetry SDK:', err.message);
  }
}

/** Increment the HTTP request counter. */
function recordHttpRequest(attributes = {}) {
  _localCounters.httpRequests++;
  _localCounters._otel?.reqCounter?.add(1, attributes);
}

/** Record a completed library scan. */
function recordScanComplete(attributes = {}) {
  _localCounters.scansRun++;
  _localCounters._otel?.scanCounter?.add(1, attributes);
}

/** Record bytes sent during a stream. */
function recordStreamBytes(bytes, attributes = {}) {
  _localCounters.bytesStreamed += bytes;
  _localCounters._otel?.bytesCounter?.add(bytes, attributes);
}

/** Record a new stream request. */
function recordStreamRequest(attributes = {}) {
  _localCounters.streamRequests++;
  _localCounters._otel?.streamCounter?.add(1, attributes);
}

/** Return a snapshot of local counters for the admin UI. */
function getStats() {
  return {
    enabled,
    otlpEndpoint: enabled ? otlpEndpoint : null,
    serviceName: process.env.OTEL_SERVICE_NAME || 'ourtube',
    counters: {
      httpRequests: _localCounters.httpRequests,
      scansRun: _localCounters.scansRun,
      bytesStreamed: _localCounters.bytesStreamed,
      streamRequests: _localCounters.streamRequests,
    },
  };
}

/**
 * Return an active OpenTelemetry Tracer (or null if disabled).
 */
function getTracer(name = 'ourtube') {
  if (!enabled) return null;
  return trace.getTracer(name);
}

module.exports = {
  init,
  recordHttpRequest,
  recordScanComplete,
  recordStreamBytes,
  recordStreamRequest,
  getStats,
  getTracer,
};
