"""Shared form utility functions for IPK Groupware form submissions."""
import time
import math
from pathlib import Path


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


# --- Own Vehicle Expense Utilities ---

IPK_ORIGIN = "경기도 성남시 분당구 대왕판교로 712번길 22"  # IPK 판교

def capture_naver_map_distance(page, destination_address: str,
                                screenshot_path: str = "screenshots/거리.pdf") -> str:
    """Open Naver Maps driving directions from IPK to destination, save as PDF.

    Just types origin/destination and screenshots — the distance is visible
    on screen and read by the person reviewing the form.

    Args:
        page: Playwright page object
        destination_address: Destination address in Korean
        screenshot_path: Output PDF path for 거리.pdf attachment

    Returns:
        Path to saved PDF screenshot
    """
    Path(screenshot_path).parent.mkdir(parents=True, exist_ok=True)

    page.goto("https://map.naver.com/p/directions/-/-/-/car",
              wait_until="domcontentloaded", timeout=15000)
    time.sleep(3)

    # Type origin (출발지)
    origin_input = page.locator('input[placeholder*="출발"]').first
    origin_input.click()
    origin_input.fill(IPK_ORIGIN)
    page.keyboard.press("Enter")
    time.sleep(2)

    # Type destination (도착지)
    dest_input = page.locator('input[placeholder*="도착"]').first
    dest_input.click()
    dest_input.fill(destination_address)
    page.keyboard.press("Enter")
    time.sleep(5)

    # Save as PDF
    page.pdf(path=screenshot_path, format="A4", print_background=True)
    return screenshot_path


def calculate_own_vehicle_cost(distance_km: float, oil_price_per_liter: float,
                                round_trip: bool = True,
                                fuel_efficiency_km_per_l: float = 10.0) -> dict:
    """Calculate own vehicle fuel cost for travel request/settlement.

    Formula: own_car_cost = oil_price_per_liter × distance_km / fuel_efficiency
    Standard government fuel efficiency rate: 10 km/L.

    Verified against real data: oil_price=1668, distance=381km (one-way)
    → 1668 × 381 / 10 = 63,551 KRW (matches approved document).

    Args:
        distance_km: One-way driving distance in km (from Naver Maps)
        oil_price_per_liter: Current fuel price in KRW/L
        round_trip: Whether to calculate round-trip cost (default True)
        fuel_efficiency_km_per_l: Fuel efficiency in km/L (default 10.0, standard rate)

    Returns:
        dict with keys: one_way_km, total_km, oil_price, own_car_cost
    """
    total_km = distance_km * 2 if round_trip else distance_km
    own_car_cost = math.ceil(oil_price_per_liter * total_km / fuel_efficiency_km_per_l)

    return {
        "one_way_km": distance_km,
        "total_km": total_km,
        "oil_price_per_liter": oil_price_per_liter,
        "fuel_efficiency_km_per_l": fuel_efficiency_km_per_l,
        "own_car_cost": own_car_cost,
        "round_trip": round_trip,
    }
