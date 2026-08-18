# VOZEB Integration

- Upstream: `xiaozangao/3d-director-desk`
- Upstream version: `0.3.1`

VOZEB keeps the upstream iframe and extension protocol while extending the host bridge with:

- session nonce validation;
- project snapshot restore and debounced project change delivery;
- panorama connection removal and clear messages;
- capture request IDs and delivery receipts;
- nonce-aware close and capture messages.

Keep these host bridge behaviors when updating from upstream.
