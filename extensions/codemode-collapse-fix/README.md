# Codemode collapse fix

Temporary workaround for [pi#10222](https://github.com/earendil-works/pi/issues/10222). Requires Pi 0.99.1's public codemode factory.

Keeps the built-in renderer, but limits collapsed script/result previews to 11/16 **wrapped screen rows**, plus an expansion hint and output-file footer when needed. Expanded rendering, execution, settings, and model-visible results remain unchanged. The limit also applies while nested calls are running.

Try once:

```sh
pi -ne --tools read,bash,edit,write,codemode \
  -e /path/to/pi-extensions/extensions/codemode-collapse-fix/index.ts
```

Included in the root package. To install only this extension:

```sh
pi install /path/to/pi-extensions/extensions/codemode-collapse-fix
```

Restart Pi after installing. Enable codemode as usual; this extension does not activate it. It supplies the codemode tool using Pi's built-in factory, so do not also load `-e builtin:codemode` or another codemode override. If the built-in extension is enabled in settings, Pi may warn that it was skipped; that is expected.

When upstream fixes the issue, remove this extension's entry from the root `package.json`. For a standalone installation:

```sh
pi remove /path/to/pi-extensions/extensions/codemode-collapse-fix
```

Restart Pi to restore the upstream renderer. No persisted data needs cleanup.
