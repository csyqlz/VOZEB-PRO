---
status: accepted
---

# Use Explicit Strategy Modes for Product Imaging

E-commerce product generation will not force every request through one image-to-image method. `strict_product` is the default for SKU and brand-preserving work and requires a trusted product mask plus protected core pixels; `integrated_scene` may trade some pixel-level preservation for more natural edge, reflection, and lighting integration; `creative_variation` is explicitly non-strict. This boundary prevents a creative result from being reported as a faithful product result and keeps later workflows extensible without weakening the first MVP's acceptance rule.
