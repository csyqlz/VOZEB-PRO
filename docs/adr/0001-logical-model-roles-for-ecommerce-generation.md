---
status: accepted
---

# Use Logical Model Roles for E-commerce Generation

The e-commerce image workflow will route through logical roles such as `vision_analysis`, `edit_planning`, `quality_check`, and `image_generation` instead of hard-coding GPT-5.6, gpt-image-2.5, or nano banana 2 into the workflow. Each role may have ordered, health-aware candidates configured by an administrator, while every run stores the actual model and compiler snapshot. This preserves the ability to add and switch models without changing the domain workflow, while keeping strict-product failures explicit instead of silently degrading to an incompatible model.
