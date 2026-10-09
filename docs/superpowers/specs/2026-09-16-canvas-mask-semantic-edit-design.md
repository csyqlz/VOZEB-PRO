# Canvas Native Mask Edit Design

## Goal

Generate the requested complete potted plant at the painted location, matching the original room's style, materials, warm sunlight, shadows, scale, and perspective.

## Verified Root Cause

Production v0.0.21 task `402b9aa8-3405-4047-a612-4330a0358b26` returned a different landscape living room. Compositing that result into the portrait source preserved the outside pixels but clipped unrelated plant fragments into the mask. The earlier hypothesis that a mask appended to `image_urls` would be consumed was incorrect.

The deployed sub2api revision `86f93c28ee34cc74b629dafb748bd5ac5ca8c5ea` parses `images[].image_url` and `mask.image_url` only for `/v1/images/edits`. Its Responses bridge sends source images as `input_image`, sets tool action `edit`, and forwards the mask as `input_image_mask.image_url`. The old `/images/generations` request with string arrays and a string mask therefore generated from text without source or selection guidance.

## Request Contract

Explicit sub2api uses `/images/edits` by default, with source/reference URL objects in `images` and the binary mask in a separate `mask.image_url`. The mask is not a scene reference. Explicit administrator edit paths retain their precedence and production saved model/operation paths must be corrected before acceptance.

The request includes `input_fidelity: high`. The deployed OAuth bridge does not forward that field; source, action, and native mask forwarding are the verified controls. Visual acceptance must demonstrate style consistency instead of assuming this parameter provides it.

Three real API comparisons showed that the native result preserves the room style and produces a complete plant. Aligning source/mask dimensions and adding strict normalized bounds still left foliage outside the narrow painted rectangle. Applying the local Alpha compositor then produced a hard rectangular edge and removed the leaves. Explicit sub2api native edits therefore keep the complete provider result. Legacy and automatically detected compatible providers retain local outside-mask pixel compositing because their mask behavior is not verified.

Automatic legacy adapters, including Code2Alita and declared `image_urls` templates, retain their existing contracts. Standard OpenAI multipart and Gemini inlineData edits remain unchanged.

## Prompt and Geometry

Reuse the validated normalized mask bounds and center already persisted by Canvas. Identify the source and separate native mask, require the entire object to fit in the editable region, and preserve the scene and its artistic style, colors, material texture, realism, light direction, warmth, exposure, shadows, scale, and perspective. Preserve the user's requested content verbatim.

The source is 1600 x 2844 while the affected node requests 3840 x 2160. Verify the native edit before deciding whether inherited output aspect preferences require correction. The compositor cannot recover a source-aligned edit from a redesigned or geometrically distorted upstream scene.

## Validation

- TCP fixture mirrors the deployed parser: generation paths and `image_urls` cannot supply edit input; native source and mask objects are required.
- Persisted model configuration and the system proxy preserve the native fields and bill one request.
- Native sub2api Canvas output bypasses local clipping through a persisted provider decision; legacy, OpenAI, Gemini, mask metadata, recovery, and pixel preservation regressions remain valid.
- Run required checks, browser gates, and real Sunburst Canvas acceptance; publish merged main as v0.0.22 and deploy latest.
