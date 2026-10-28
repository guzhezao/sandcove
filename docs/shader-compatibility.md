# Shader portability

Multi-component swizzles are read-only in the browser WGSL baseline used here. Reconstruct the whole vector for writes, retaining untouched components explicitly. For grains, position.w carries mass and velocity.w carries age, so neither may be discarded when changing xyz.

The installed headless Dawn binding accepted compound swizzle writes that the user's browser rejected during particle shader compilation. Its successful compilation is not proof of browser portability. The source-level regression test rejects multi-component swizzle assignments in all shipped shader modules; headless GPU tests separately verify execution, mass conservation, and offscreen rendering. Browser validation remains a manual check.

WGSL reserved words are also treated as source-level compatibility hazards. In particular, local identifiers must not use `active`, which Chrome/Dawn rejects as a reserved keyword even when other shader validation paths do not surface it.
