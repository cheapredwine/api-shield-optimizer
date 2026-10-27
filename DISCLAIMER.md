# ⚠️ DISCLAIMER — READ THIS BEFORE YOU RUN ANYTHING

## NOT OFFICIAL. NOT AFFILIATED. NOT ENDORSED.

This project is **NOT an official Cloudflare product**. It is not affiliated with,
endorsed by, sponsored by, certified by, reviewed by, or in any way connected to
Cloudflare, Inc. "Cloudflare" and all related marks are trademarks of Cloudflare, Inc.;
their use here is purely descriptive and does not imply any relationship.
The author is solely responsible for this code — not Cloudflare.

## NO WARRANTIES — EXPRESS OR IMPLIED

This software is provided **"AS IS", WITH ALL FAULTS, AND WITHOUT ANY WARRANTY OF ANY
KIND**. There is **NO WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
NON-INFRINGEMENT, ACCURACY, OR THAT IT WILL WORK AT ALL**. To the maximum extent
permitted by applicable law, the author disclaims all warranties, express or implied.

## EFFECTIVELY UNTESTED

This is **personal, experimental, demo-grade code**, largely written for internal
demonstrations and talks. It is **effectively untested**: it has not been through
security review, QA, penetration testing, code audit, or any formal validation
whatsoever. It may be broken. It may be insecure. It may delete things. It may cost
you money (API spend, provisioned resources, dangling infrastructure). It may stop
working without notice whenever an upstream API changes.

## DO NOT RUN THIS BLINDLY

**You should not run this without reading it first.** Every deploy script, Terraform
plan, and API call in this repo can create, modify, or **permanently delete** real
resources in real Cloudflare accounts. Review every line, dry-run everything, scope
it to a throwaway account, and assume the worst case before you execute anything.

## NO LIABILITY

In no event shall the author be liable for any claim, damages, data loss, outage,
cost, or other liability — direct, indirect, incidental, special, exemplary, or
consequential — arising from, out of, or in connection with this software or its use,
**even if advised of the possibility of such damage**. Some jurisdictions do not allow
limitation of certain warranties or damages; to the extent such law applies, the
author's liability is limited to the smallest amount permitted by law.

## YOU OWN IT FROM HERE

If you fork, run, deploy, or rely on any of this, **you accept full and sole
responsibility for every consequence**. That's the deal.
