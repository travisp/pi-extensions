# OpenRouter Jev only

Replaces Pi's OpenRouter provider catalog with only the classifiers
`typesafe/jev-1.13` and `~typesafe/jev-latest`. OpenRouter chat and image
models are hidden from model discovery, including the model picker and extensions
using Pi's registry. Authentication and classifier requests use Pi's built-in
OpenRouter implementation. Other providers are unchanged.

Requires Pi 0.99.1 or newer. Included in the root package, or load individually:

```bash
pi -e ./extensions/openrouter-jev-only/index.ts
```

Reload Pi after enabling it. This is a discovery restriction, not a security
boundary: captured model definitions and direct HTTP requests can bypass it.
Use an OpenRouter API-key model allowlist to enforce permitted requests.
