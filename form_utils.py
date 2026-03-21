"""Shared form utility functions for IPK Groupware form submissions."""
import time


def escape_js(s):
    """Escape string for JavaScript single-quoted template"""
    return s.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n').replace('\r', '\\r')


def escape_js_double(s):
    """Escape string for JavaScript double-quoted strings"""
    return s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r')


def set_field(frame, name, value, delay=0.3):
    """Set input/textarea value by name with event dispatch"""
    frame.evaluate(f"""(() => {{
        const el = document.querySelector('[name="{name}"]');
        if (el) {{
            el.readOnly = false;
            el.value = '{escape_js(value)}';
            el.dispatchEvent(new Event('input', {{bubbles: true}}));
            el.dispatchEvent(new Event('change', {{bubbles: true}}));
        }}
    }})()""")
    time.sleep(delay)


def set_select(frame, name, value, delay=1.0):
    """Set select value and trigger change event (for AJAX cascades)"""
    frame.evaluate(f"""(() => {{
        const el = document.querySelector('select[name="{name}"]');
        if (el) {{
            el.value = '{escape_js(value)}';
            el.dispatchEvent(new Event('change', {{bubbles: true}}));
        }}
    }})()""")
    time.sleep(delay)


def set_radio(frame, name, value, delay=0.5):
    """Set radio button by name and value"""
    frame.evaluate(f"""(() => {{
        const radios = document.querySelectorAll('input[name="{name}"]');
        for (const r of radios) {{
            if (r.value === '{escape_js(value)}') {{
                r.checked = true;
                r.click();
                r.dispatchEvent(new Event('change', {{bubbles: true}}));
                break;
            }}
        }}
    }})()""")
    time.sleep(delay)


def select_option_containing(frame, name, text, delay=1.5):
    """Select an option whose text contains the given string"""
    result = frame.evaluate(f"""(() => {{
        const sel = document.querySelector('select[name="{name}"]');
        if (!sel) return {{found: false, error: 'select not found'}};
        const opts = Array.from(sel.options).map(o => ({{value: o.value, text: o.text}}));
        for (const o of opts) {{
            if (o.text.includes('{escape_js(text)}') && o.value) {{
                sel.value = o.value;
                sel.dispatchEvent(new Event('change', {{bubbles: true}}));
                return {{found: true, selected: o, total: opts.length}};
            }}
        }}
        // Fallback: first non-empty option
        for (const o of opts) {{
            if (o.value) {{
                sel.value = o.value;
                sel.dispatchEvent(new Event('change', {{bubbles: true}}));
                return {{found: true, selected: o, total: opts.length, fallback: true}};
            }}
        }}
        return {{found: false, options: opts.slice(0, 10), total: opts.length}};
    }})()""")
    time.sleep(delay)
    return result
