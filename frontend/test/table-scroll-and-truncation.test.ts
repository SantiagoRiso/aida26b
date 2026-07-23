/**
 * The table header is declared sticky, but sticky only engages against a scrollport that scrolls.
 * The wrapper scrolls horizontally (which makes overflow-y compute to auto), so it — not the page —
 * is that scrollport, and it has to be given a height for the header to have anything to stick to.
 *
 * The second half covers the other half of the same problem: a value too wide for its cell is only
 * reachable through a `title` tooltip, which never fires without a pointer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import { createI18n } from 'vue-i18n';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { es } from '@/i18n/es';
import { en } from '@/i18n/en';
import { useAuthStore } from '@/stores/auth';
import { LIST_DEFAULT_LIMIT } from '@shared/ssot/list-protocol';
import type { TableKey } from '@shared/ssot/derived';
import {
  availableScrollHeight,
  findScrollParent,
  measureTableScrollHeight,
  MIN_TABLE_SCROLL_HEIGHT,
} from '@/composables/tableScrollHeight';
import GenericTable from '@/components/generic/GenericTable.vue';

const longDescription =
  'Corte con lavado, secado y peinado, incluye asesoramiento sobre el mantenimiento en casa';

vi.mock('@/api/crud', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/crud')>();
  return {
    ...actual,
    listRows: vi.fn().mockResolvedValue({
      ok: true,
      data: [
        {
          id: '1',
          business_id: '1',
          name: 'Corte simple',
          description:
            'Corte con lavado, secado y peinado, incluye asesoramiento sobre el mantenimiento en casa',
          default_duration_minutes: 30,
          default_price_ars: '500.00',
        },
      ],
      meta: { page: 1, limit: LIST_DEFAULT_LIMIT, total: 1 },
    }),
    getRow: () => Promise.resolve({ ok: false, status: 404, code: 'not_found', message: 'not found' }),
    createRow: vi.fn(),
    updateRow: vi.fn(),
    deleteRow: vi.fn(),
  };
});

describe('the height a table scroller may take', () => {
  const scroller = { top: 0, bottom: 800, clientHeight: 800, scrollTop: 0 };

  it('leaves room for what sits above the table and for the pagination below it', () => {
    const height = availableScrollHeight(
      scroller,
      { top: 150, bottom: 600 },
      { top: 0, bottom: 660 },
    );
    expect(height).toBe(800 - 150 - 60);
  });

  /* Both terms are distances to the element's own edges, so the answer must not depend on how tall
     the element currently is — otherwise applying the cap would change the next measurement. */
  it('is unchanged by the table\'s current height', () => {
    const short = availableScrollHeight(scroller, { top: 150, bottom: 300 }, { top: 0, bottom: 360 });
    const tall = availableScrollHeight(scroller, { top: 150, bottom: 2000 }, { top: 0, bottom: 2060 });
    expect(short).toBe(tall);
  });

  /* The element's distance from the top of the scrolled content, not from the viewport: a table
     measured while the page is scrolled must get the same cap as one measured at the top. */
  it('is unchanged by how far the scroller has been scrolled', () => {
    const atTop = availableScrollHeight(scroller, { top: 150, bottom: 600 }, { top: 0, bottom: 660 });
    const scrolled = availableScrollHeight(
      { ...scroller, scrollTop: 120 },
      { top: 30, bottom: 480 },
      { top: -120, bottom: 540 },
    );
    expect(scrolled).toBe(atTop);
  });

  it('never shrinks below a readable scrolling region', () => {
    const height = availableScrollHeight(scroller, { top: 780, bottom: 790 }, { top: 0, bottom: 800 });
    expect(height).toBe(MIN_TABLE_SCROLL_HEIGHT);
  });
});

describe('finding the scrollport the header will stick to', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('picks the nearest scrolling ancestor', () => {
    const outer = document.createElement('div');
    outer.style.overflowY = 'auto';
    const middle = document.createElement('div');
    const inner = document.createElement('div');
    outer.appendChild(middle);
    middle.appendChild(inner);
    document.body.appendChild(outer);

    expect(findScrollParent(inner)).toBe(outer);
  });

  /* Capping against an ancestor that does not scroll would invent a height nothing asked for. */
  it('reports none when nothing above scrolls, and measures no cap', () => {
    const plain = document.createElement('div');
    const inner = document.createElement('div');
    plain.appendChild(inner);
    document.body.appendChild(plain);

    expect(findScrollParent(inner)).toBeNull();
    expect(measureTableScrollHeight(inner)).toBeNull();
  });
});

function makePlugins() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore(pinia);
  auth.user = {
    id: 1,
    username: 'admin',
    email: null,
    role: 'Admin',
    business_id: null,
    is_active: true,
    must_change_password: false,
  };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  });
  const i18n = createI18n({ legacy: false, locale: 'es', messages: { es, en } });
  return { pinia, router, i18n };
}

function stubRect(el: Element, top: number, bottom: number) {
  el.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) });
}

describe('GenericTable keeps its header on screen while a long list scrolls', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    host.style.overflowY = 'auto';
    document.body.appendChild(host);
  });
  afterEach(() => { document.body.innerHTML = ''; });

  async function mountInScroller() {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
      attachTo: host,
    });
    await flushPromises();
    return wrapper;
  }

  it('caps its own scrollport to the room left in the scrolling ancestor', async () => {
    const wrapper = await mountInScroller();
    const scrollBox = wrapper.find('[data-testid="table-scroll"]');
    const element = scrollBox.element;

    Object.defineProperty(host, 'clientHeight', { value: 800, configurable: true });
    stubRect(host, 0, 800);
    stubRect(element, 150, 600);
    stubRect(element.parentElement!, 0, 660);

    window.dispatchEvent(new Event('resize'));
    await flushPromises();

    expect(scrollBox.attributes('style')).toContain('max-height: 590px');
  });

  /* Without a cap the wrapper grows to fit the table, never scrolls, and the sticky header is inert:
     the guarantee is the pairing of the two, so both are asserted together. */
  it('sticks the header cells to the top of that scrollport', async () => {
    const wrapper = await mountInScroller();
    const headers = wrapper.findAll('th');
    expect(headers.length).toBeGreaterThan(0);
    for (const th of headers) {
      expect(th.classes()).toContain('sticky');
      expect(th.classes()).toContain('top-0');
    }
    expect(wrapper.find('[data-testid="table-scroll"]').classes()).toContain('overflow-auto');
  });
});

describe('a value too wide for its cell stays reachable without a pointer', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('keeps the title tooltip carrying the full value for pointer users', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const cell = wrapper.findAll('td').find((td) => td.text() === longDescription);
    expect(cell).toBeDefined();
    expect(cell!.attributes('title')).toBe(longDescription);
  });

  /* Truncation is applied through a named class rather than Tailwind's `truncate` so the no-pointer
     media query can undo it; a cell back on `truncate` would be unreadable on a phone again. */
  it('truncates through the class the no-pointer rule can reverse', async () => {
    const { pinia, router, i18n } = makePlugins();
    const wrapper = mount(GenericTable, {
      props: { tableKey: 'services' as TableKey },
      global: { plugins: [pinia, router, i18n] },
    });
    await flushPromises();

    const cell = wrapper.findAll('td').find((td) => td.text() === longDescription)!;
    expect(cell.classes()).toContain('cell-truncate');
    expect(cell.classes()).not.toContain('truncate');
  });

  it('unsets every part of the clipping where the device has no hover', () => {
    const css = readFileSync(join(__dirname, '../src/styles/main.css'), 'utf-8');
    const rule = css.match(/@media\s*\(hover:\s*none\)\s*\{\s*\.cell-truncate\s*\{([^}]*)\}/);
    expect(rule, 'no (hover: none) override for .cell-truncate').not.toBeNull();

    const body = rule![1];
    // Leaving any one of the three in place keeps the value clipped.
    expect(body).toMatch(/white-space:\s*normal/);
    expect(body).toMatch(/text-overflow:\s*clip/);
    expect(body).toMatch(/overflow:\s*visible/);
    // A long unbroken value (an email, an id) would still overrun a 390px screen without this.
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
