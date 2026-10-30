import "reflect-metadata"

process.env.NODE_ENV = "test"
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/switchboard_test"
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/14"
process.env.JWT_SECRET = "test-jwt-secret-test-jwt-secret-test"
process.env.APP_URL = "http://switchboard.test"
process.env.UPLOAD_DIR = "/tmp/switchboard-test-uploads"
process.env.RATE_LIMIT = "false"
