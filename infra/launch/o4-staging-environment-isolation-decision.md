# O4 Decision: Staging environment isolation strategy

## Context

Staging must never reach production data. Currently there is no staging database or staging Core API Function (ADR 0013: one Neon project), but when staging is created, it will need protection.

The gateway Worker (`muniramarket-api-gateway-staging`) holds a secret `CORE_API_FUNCTION_ORIGIN` that tells it which Neon Function to call. If that secret is misconfigured to point to production, staging could serve production data.

## Current safeguards (dual-layer)

1. **Config-time validation** (`validate-deploy-env.mts --mode staging`):
   - Requires the operator to record both the staging gateway's target host (`MM_CORE_API_FUNCTION_HOST`) and production's (`MM_PRODUCTION_FUNCTION_HOST`) as plain variables
   - Fails the deploy if they are equal
   - **Limitation:** cannot read the actual secret; only checks what the operator declares

2. **Request-time secret verification**:
   - The staging gateway's `CORE_API_FUNCTION_SECRET` differs from production's
   - If the gateway's `CORE_API_FUNCTION_ORIGIN` is mis-pointed to production, the request still fails with 401 (Unauthorized)
   - **Limitation:** relies on secrets being different; offers no defense if secrets are shared

## Proposed third layer: APP_ENV fail-closed check

**What:** The gateway sends an `APP_ENV` header (or query param) on each request; the Function rejects requests where `APP_ENV` does not match its own environment (from the Function secret `APP_ENV=staging|production`).

**Benefits:**

- Fail-closed: prevents staging from reaching production _even if_ the gateway's `CORE_API_FUNCTION_ORIGIN` secret is misconfigured to point to production
- Does not depend on secrets being different
- Transparent to the client (not part of the API contract)

**Drawbacks:**

- Requires changes to gateway-to-Function authentication (critical path)
- Adds latency: one more header validation in every request
- Increases complexity: introduces `APP_ENV` as a new required Function secret
- Risk: a bug in the validation logic could block legitimate traffic (but testable)

## Decision required

**Option A (Status quo):** Keep the dual-layer protection. Accept that operator config mistakes could expose production data to staging (mitigated by: config validation + different secrets).

**Option B (Add APP_ENV check):** Implement fail-closed validation. Trade added complexity and latency for defense-in-depth.

## Recommendation

**Option A** unless the risk tolerance or compliance requirements explicitly demand Option B. The dual-layer approach is simpler, faster, and relies on strong operational discipline (documented in the launch checklist). If Option A is chosen, add a note to the launch checklist emphasizing the importance of different secrets and accurate host recording.

---

**Decided by:** _(Operator/team lead to sign here)_  
**Date:** _(Date of decision)_  
**Choice:** ☐ Option A (dual-layer) | ☐ Option B (add APP_ENV check)  
**Rationale:** _(Brief note on why this choice was made)_
