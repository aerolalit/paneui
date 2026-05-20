-- Agent feedback channel: one-shot bug / feature / note submissions from
-- agents to the operator. Nullable agentId + sessionId with SetNull cascade
-- so feedback outlives the agent/session it referenced. githubIssueUrl is
-- reserved for future GH forwarding (unused in v1).
CREATE TABLE "feedback" (
  "id" TEXT NOT NULL,
  "agent_id" TEXT,
  "type" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "session_id" TEXT,
  "github_issue_url" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "feedback_agent_id_created_at_idx" ON "feedback"("agent_id", "created_at");
CREATE INDEX "feedback_created_at_idx" ON "feedback"("created_at");

ALTER TABLE "feedback" ADD CONSTRAINT "feedback_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
