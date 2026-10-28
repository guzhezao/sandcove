# Post-processing

The scene render target is `rgba16float` and stores linear HDR radiance from both the sand surface and loose grains. Surface/material shaders do not tone-map or apply sRGB conversion.

Visual parity with the deployed renderer remains the baseline. Before the bloom/filmic composite, one full-screen encode pass applies the exact legacy tone curve and sRGB transform into an 8-bit texture using the same format the scene used previously. The legacy filtering, bloom threshold/knee, kernel, filmic grade, and final canvas output remain unchanged.

The HDR scene clear value is the inverse of the legacy display transform for the previous clear color, so uncovered pixels retain the same visible color after the encode pass.

Reflective mineral flashes use a separate `r16float` attachment. The main sand image still goes through the established parity-preserving display path first. The post pass then reconstructs the sub-pixel flash separately as a softer optical sparkle: a warm near-white core, short streak-like structure reconstructed from neighboring samples, and a broader smeared glow so the result reads more like a tiny lensy reflection than a stamped white dot. This intentionally gives the flash much higher display contrast than ordinary sand while leaving exposure, bloom, color grading, and all non-glint pixels unchanged. Portrait mobile viewports now automatically taper the sparkle footprint and gain during the final composite so the glints stay proportional to the finer apparent sand grain scale instead of overwhelming the surface.

Do not retune exposure, contrast, saturation, or general material colors as part of pipeline work. Any future move of the legacy bloom or grading into HDR space is a separate appearance change and must be evaluated independently against the deployed look.

The reset-water composite is conditional. Outside an active reset, the filmic post pass writes directly to the canvas target and the water overlay pass is not encoded at all. During a reset, the filmic result is kept in the composite texture because it is the refracted scene source for the water pass. The water surface and caustic fields are fixed-resolution world-space render targets; display resolution only affects the final optical composite, not the procedural wave or caustic transport workload.
