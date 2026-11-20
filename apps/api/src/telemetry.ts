import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';

/** Imported first by main.ts so instrumentation patches http/pg before they load.
 *  Tracing is enabled only when OTEL_EXPORTER_OTLP_ENDPOINT is set. */
function start(): NodeSDK | null {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'runvara-api',
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [new HttpInstrumentation({ ignoreIncomingRequestHook: (r) => r.url === '/healthz' || r.url === '/readyz' }), new PgInstrumentation()],
  });
  sdk.start();
  return sdk;
}

export const telemetry = start();
