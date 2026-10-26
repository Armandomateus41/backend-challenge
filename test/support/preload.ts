import { configureLogger } from '../../src/observability/logger';

// Test output stays readable; set TEST_LOG_LEVEL=info to see application logs.
configureLogger({ level: process.env.TEST_LOG_LEVEL ?? 'silent', instanceId: 'test' });
