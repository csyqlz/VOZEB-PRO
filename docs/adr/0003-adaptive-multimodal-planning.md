---
status: accepted
---

# Use Adaptive Execution for Multimodal Planning

The product workflow will keep `vision_analysis` and `edit_planning` as separate logical contracts, while allowing their physical calls to be merged for simple requests. Strict e-commerce product workflows use the staged path so reference roles, protected product regions, edit targets, and masks can be validated independently; a fast path can be introduced later without changing the domain model. This avoids both a coupled one-shot prompt and unnecessary multi-call latency for simple edits.
