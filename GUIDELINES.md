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

---

## Error Handling

### Use try-catch only when necessary
- ✅ Version-specific API calls that may not exist
- ✅ External/async operations that can genuinely fail
- ❌ Simple property access or safe operations
- ❌ Empty catch blocks with `// ignore`

```javascript
// ❌ Bad - unnecessary try-catch
try {
    const value = this._settings.get_boolean('key');
} catch (e) {
    // ignore
}

// ✅ Good - used for version compatibility
try {
    this._signalId = controller.connect('page-changed', handler);
} catch (e) {
    // Signal may not exist in this GNOME version
}
```

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
