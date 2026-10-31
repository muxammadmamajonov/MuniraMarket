# Launch

| Checklist                                                | Owner                     | When                                |
| -------------------------------------------------------- | ------------------------- | ----------------------------------- |
| [launch-checklist.md](launch-checklist.md)               | engineering + operator    | before the first production deploy  |
| [device-uat-checklist.md](device-uat-checklist.md)       | QA / team on real devices | on staging, then once on production |
| [legal-content-checklist.md](legal-content-checklist.md) | business owner + lawyer   | before the storefront goes public   |

Automated part of the gate: `node infra/cloudflare/scripts/launch-gate.mts` (with the production
deploy variables exported). It fails while legal content is pending, while any production
variable is missing or invalid, or if the admin would load images from a host its CSP does not
allow-list.
