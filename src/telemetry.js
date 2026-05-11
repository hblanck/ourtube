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
let _engagementGauges = null;
let _engagementUpdateInterval = null;

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

    // Engagement metrics (gauges updated from database)
    const totalViewsGauge = _meter.createObservableGauge('ourtube.engagement.total_views', { description: 'Total views across all media' });
    const totalSessionsGauge = _meter.createObservableGauge('ourtube.engagement.total_sessions', { description: 'Total client sessions' });
    const uniqueViewersGauge = _meter.createObservableGauge('ourtube.engagement.unique_viewers', { description: 'Unique viewer IPs' });
    const avgSessionDurationGauge = _meter.createObservableGauge('ourtube.engagement.avg_session_duration_seconds', { description: 'Average session duration in seconds' });
    const totalBytesSessionsGauge = _meter.createObservableGauge('ourtube.engagement.total_bytes_sessions', { description: 'Total bytes sent across sessions' });
    const mediaViewedGauge = _meter.createObservableGauge('ourtube.engagement.media_viewed', { description: 'Unique media items viewed' });

    _engagementGauges = {
      totalViews: totalViewsGauge,
      totalSessions: totalSessionsGauge,
      uniqueViewers: uniqueViewersGauge,
      avgSessionDuration: avgSessionDurationGauge,
      totalBytesSessions: totalBytesSessionsGauge,
      mediaViewed: mediaViewedGauge,
      values: {
        totalViews: 0,
        totalSessions: 0,
        uniqueViewers: 0,
        avgSessionDuration: 0,
        totalBytesSessions: 0,
        mediaViewed: 0,
      }
    };

    // Set up observable callbacks for gauges
    _meter.addBatchObservableCallback((batchObservableCallback) => {
      batchObservableCallback.observe(totalViewsGauge, _engagementGauges.values.totalViews);
      batchObservableCallback.observe(totalSessionsGauge, _engagementGauges.values.totalSessions);
      batchObservableCallback.observe(uniqueViewersGauge, _engagementGauges.values.uniqueViewers);
      batchObservableCallback.observe(avgSessionDurationGauge, _engagementGauges.values.avgSessionDuration);
      batchObservableCallback.observe(totalBytesSessionsGauge, _engagementGauges.values.totalBytesSessions);
      batchObservableCallback.observe(mediaViewedGauge, _engagementGauges.values.mediaViewed);
    }, [
      totalViewsGauge,
      totalSessionsGauge,
      uniqueViewersGauge,
      avgSessionDurationGauge,
      totalBytesSessionsGauge,
      mediaViewedGauge,
    ]);

    // Attach the meter counters so callers can increment them
    _localCounters._otel = { reqCounter, scanCounter, bytesCounter, streamCounter };

    // Start periodic engagement metrics update
    startEngagementMetricsUpdate();

    process.on('SIGTERM', () => {
      stopEngagementMetricsUpdate();
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

/** Update engagement metrics from database (session stats and library views). */
function updateEngagementMetrics() {
  if (!_engagementGauges) return;

  try {
    const { getDb } = require('./db');
    const db = getDb();

    // Get session stats
    const sessionStats = db.prepare(
      `SELECT
          COUNT(*) as total_sessions,
          COUNT(DISTINCT client_ip) as unique_ips,
          COUNT(DISTINCT media_id) as media_viewed,
          AVG(COALESCE(duration_seconds, 0)) as avg_duration_seconds,
          SUM(COALESCE(bytes_sent, 0)) as total_bytes_sent
       FROM client_session_log`
    ).get();

    // Get total views from media
    const viewStats = db.prepare(
      `SELECT SUM(view_count) as total_views FROM media`
    ).get();

    if (sessionStats) {
      _engagementGauges.values.totalSessions = sessionStats.total_sessions || 0;
      _engagementGauges.values.uniqueViewers = sessionStats.unique_ips || 0;
      _engagementGauges.values.avgSessionDuration = Math.round(sessionStats.avg_duration_seconds) || 0;
      _engagementGauges.values.totalBytesSessions = sessionStats.total_bytes_sent || 0;
      _engagementGauges.values.mediaViewed = sessionStats.media_viewed || 0;
    }

    if (viewStats) {
      _engagementGauges.values.totalViews = viewStats.total_views || 0;
    }
  } catch (err) {
    console.warn('[telemetry] Failed to update engagement metrics:', err.message);
  }
}

/** Start the periodic engagement metrics update interval. */
function startEngagementMetricsUpdate() {
  if (!_engagementGauges || _engagementUpdateInterval) return;

  // Update immediately
  updateEngagementMetrics();

  // Then update every 30 seconds
  _engagementUpdateInterval = setInterval(() => {
    updateEngagementMetrics();
  }, 30_000);
}

/** Stop the periodic engagement metrics update interval. */
function stopEngagementMetricsUpdate() {
  if (_engagementUpdateInterval) {
    clearInterval(_engagementUpdateInterval);
    _engagementUpdateInterval = null;
  }
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
