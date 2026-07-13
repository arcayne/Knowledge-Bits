DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knowledge_bits_runtime') THEN
    CREATE ROLE knowledge_bits_runtime NOLOGIN;
  END IF;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM knowledge_bits_runtime;
GRANT USAGE ON SCHEMA public TO knowledge_bits_runtime;
REVOKE CREATE ON SCHEMA public FROM knowledge_bits_runtime;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM knowledge_bits_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM knowledge_bits_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "Run",
  "Stage",
  "Job",
  "WorkflowEffect",
  "Artifact",
  "Review",
  "PackageVersion",
  "Delivery"
TO knowledge_bits_runtime;
