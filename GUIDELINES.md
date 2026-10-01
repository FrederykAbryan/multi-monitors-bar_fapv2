# Multi Monitors Bar - Coding Guidelines

This document defines coding standards for the Multi Monitors Bar GNOME Shell extension to ensure consistency and compliance with [EGO Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html).

## Logging

### Use `console.*` instead of `log()`
GNOME 45+ deprecates the global `log()` function. Use:
- `console.debug()` - Debug messages (only visible in debug mode)
- `console.log()` - General info
- `console.warn()` - Warnings
- `console.error()` - Errors

```javascript
// ❌ Bad
log('Something happened');

// ✅ Good
console.debug('[MultiMonitors] Something happened');
```

### Prefix all logs
Use `[MultiMonitors]` prefix for easy filtering in journal.

---

## Timeout/Interval Sources

### Always track and cleanup main loop sources
Per EGO guidelines, ALL sources MUST be removed in `disable()`, even one-shot timeouts.

```javascript
// ❌ Bad - timeout not tracked
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    doSomething();
    return GLib.SOURCE_REMOVE;
});

// ✅ Good - timeout tracked and cleaned up
const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
    this._pendingTimeouts = this._pendingTimeouts.filter(id => id !== timeoutId);
    doSomething();
    return GLib.SOURCE_REMOVE;
});
this._pendingTimeouts.push(timeoutId);
```

### Cleanup pattern
```javascript
// In constructor/init
this._pendingTimeouts = [];

// In destroy()
for (let timeoutId of this._pendingTimeouts) {
    if (timeoutId) GLib.source_remove(timeoutId);
}
this._pendingTimeouts = [];
```

### Do not wrap source removal in try-catch
Tracked GLib source IDs are owned by the class that created them. Remove them directly, then null the stored ID.

```javascript
// ❌ Bad - hides lifecycle bugs
try {
    GLib.source_remove(this._timeoutId);
} catch (_e) {
}

// ✅ Good
if (this._timeoutId) {
    GLib.source_remove(this._timeoutId);
    this._timeoutId = null;
}
```

---

## Signal Connections

### Always disconnect signals in destroy()
```javascript
// Store connection ID
this._signalId = someObject.connect('signal-name', this._handler.bind(this));

// In destroy()
if (this._signalId) {
    someObject.disconnect(this._signalId);
    this._signalId = null;
}
```

### Do not wrap `disconnect()` or `disconnectObject()` in try-catch
This applies to **both** forms, with no exceptions:

- `object.disconnect(id)` — the ID was created by us against that same object.
- `object.disconnectObject(this)` — a no-op when nothing is connected, so it cannot throw
  for the reason people usually guard against.

If a disconnect can fail, the object reference is stale — fix ownership and reference cleanup
instead of swallowing the error. Null-check the *reference*, never the call.

```javascript
// ❌ Bad - masks stale object references
try {
    this._source.disconnect(this._signalId);
} catch (_e) {
}

// ❌ Bad - disconnectObject is already a no-op; the catch only hides a dead reference
try {
    this._adjustment.disconnectObject(this);
} catch (_e) {
}

// ✅ Good
if (this._signalId) {
    this._source.disconnect(this._signalId);
    this._signalId = null;
}

// ✅ Good - guard the nullable reference, then call plainly
this._adjustment?.disconnectObject(this);
```

---

## Class Structure

### Use `destroy()` for cleanup, not `vfunc_destroy()`
Put all cleanup logic in `destroy()`. Only call `super.vfunc_destroy()` in `vfunc_destroy()`.

```javascript
destroy() {
    // All cleanup here: signals, timeouts, children
    if (this._timeoutId) {
        GLib.source_remove(this._timeoutId);
        this._timeoutId = null;
    }
    super.destroy();
}

vfunc_destroy() {
    super.vfunc_destroy();
}
```

### Do not use `_isDestroyed` guard flags
Avoid flags such as `this._isDestroyed` or `this._isCleanedUp` to prevent access after destroy. The owner should null the property that holds the instance after calling `destroy()`, and destroyed objects should null their owned references during cleanup.

```javascript
// ❌ Bad
if (this._isDestroyed)
    return;
this._isDestroyed = true;

// ✅ Good - owner side
if (this._panel) {
    this._panel.destroy();
    this._panel = null;
}

// ✅ Good - destroyed instance cleanup
destroy() {
    if (this._signalId) {
        this._source.disconnect(this._signalId);
        this._signalId = null;
    }
    this._source = null;
    super.destroy();
}
```

---

## Defensive Checks

### Do not guard methods that are guaranteed to exist
`?.()` and `typeof x === 'function'` on GNOME/Clutter/St API is noise. A `St.Widget` always has
`get_first_child()`; a `Clutter.Event` always has `get_button()`. Guarding them says the author did
not know the type, which reviewers read as machine-generated code. Call them directly.

```javascript
// ❌ Bad - these methods cannot be missing
const child = this._sourceIndicator?.get_first_child?.();
actor.remove_style_pseudo_class?.('active');
if (event?.get_button?.() === Clutter.BUTTON_SECONDARY)

// ✅ Good
const child = this._sourceIndicator.get_first_child();
actor.remove_style_pseudo_class('active');
if (event.get_button() === Clutter.BUTTON_SECONDARY)
```

`?.` on a *reference* that is legitimately nullable is fine — the problem is `?.` on the **call**,
and chains that guard both at once (`a?.b?.()`). Null-check the reference once, then call plainly.

```javascript
// ❌ Bad - guards the call as well as the reference
this._sourceIndicator?.get_first_child?.()?.disconnectObject?.(this);

// ✅ Good - the reference may be null; the method may not
const child = this._sourceIndicator?.get_first_child();
child?.disconnectObject(this);
```

### Do not guard our own methods
Methods we define on our own classes always exist. `p?._ensureVitalsMirrorRightSide?.()` on our own
panel objects is guarding against a bug we would want to see, not a real condition.

### Duck-typing foreign extensions is legitimate — comment why
Third-party extensions (ArcMenu, Blur My Shell, Clipboard Indicator) are genuinely optional and their
APIs genuinely vary. Keep those checks, but name the extension so the intent is unambiguous.

```javascript
// ✅ Good - ArcMenu is optional and its API differs across releases
if (typeof this._sourceIndicator.toggleMenu === 'function')
    return this._openArcMenu();
```

### Version compatibility must reference a version
A `typeof` check for shell-version differences is fine when the difference is real and the comment
says which versions differ. If it applies to every version in `shell-version`, delete it.

---

## Error Handling

### Avoid unnecessary try-catch wrappers

Follow [GNOME Extension Best Practices: Avoid Unnecessary try-catch Wrappers](https://gjs.guide/extensions/review-guidelines/best-practices.html#avoid-unnecessary-try-catch-wrappers).

Do not wrap operations that do not throw during normal execution. This includes
`destroy()`, `connect()`, `disconnect()`, `disconnectObject()`, `abort()`,
`GLib.Source.remove()`, and `GLib.source_remove()`. Call them directly and manage
their references and signal/source IDs correctly. Fix lifecycle bugs instead of
hiding them behind a catch.

- Use a catch only for a concrete, expected failure, such as malformed external JSON or a failing I/O operation, with meaningful recovery or error reporting.
- Keep the try block limited to the operation that can fail; do not wrap an entire method or callback containing ordinary UI work.
- Do not catch simple property access, settings reads for known schema keys, or normal actor creation, updates, and cleanup.
- Missing APIs or signals are not a blanket exception. Target the declared Shell versions and use documented version differences or signal introspection where needed.
- Do not add empty catches, catches containing only `// ignore`, or logging-only wrappers around operations that should run directly.
- Third-party integration alone does not justify a catch: identify the specific failing operation and recovery.

`try`/`finally` is different: it may restore temporary state while allowing errors
to propagate. Do not add a catch just to perform that restoration.

```javascript
// ❌ Bad - unnecessary try-catch
try {
    const value = this._settings.get_boolean('key');
} catch (e) {
    // ignore
}

// ✅ Good - recover from malformed external input
let data;
try {
    data = JSON.parse(contents);
} catch (e) {
    console.warn(`[MultiMonitors] Invalid external JSON: ${e.message}`);
    return;
}
processData(data);
```

### Required check before submission

Review every `try`/`catch` in the files included in the submission archive. For each
catch, identify the operation that can throw during normal execution and the
recovery it provides. Remove wrappers that cannot satisfy both requirements,
including nested wrappers and broad catches that conceal routine cleanup. Verify
the actual archive after rebuilding; documenting this rule does not make existing
code compliant.

---

## Module Variables

### Initialize at module level
```javascript
let _originalFunction = null;
let _settings = null;
let _pendingTimeouts = [];
```

### Reset in unpatch/disable functions
```javascript
export function unpatch() {
    _settings = null;
    _originalFunction = null;
    _pendingTimeouts = [];
}
```

---

## Code Style

- Use `const` for variables that won't be reassigned
- Use `let` for variables that will be reassigned
- Avoid `var`
- Use arrow functions for callbacks
- Use template literals for string interpolation
- Add JSDoc comments for public functions
