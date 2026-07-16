import { describe, expect, it } from 'vitest';
import { createDragGhost } from '@/composables/dragGhost';

describe('drag ghost', () => {
  it('restores full width after overlap displacement changes the element directly', () => {
    const source = document.createElement('div');
    const parent = document.createElement('div');
    document.body.append(source, parent);
    const rect = { left: 10, top: 20, width: 300, height: 50 } as DOMRect;
    const dragGhost = createDragGhost(source, rect, parent);
    const element = parent.querySelector<HTMLElement>('.fc-drag-ghost')!;

    element.style.width = '150px';
    dragGhost.move({ top: 20, left: 10, width: 300, height: 50 });

    expect(element.style.width).toBe('300px');
    dragGhost.destroy();
    source.remove();
    parent.remove();
  });
});
