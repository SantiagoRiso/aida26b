import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { Dialog } from '@headlessui/vue';
import DetailPanel from '@/components/shared/DetailPanel.vue';

describe('DetailPanel stacking', () => {
  it('ignores outside-close while a confirmation dialog is in front', async () => {
    const wrapper = mount(DetailPanel, {
      props: { open: true, title: 'Detalle' },
      global: { stubs: { teleport: true } },
    });
    const foreground = document.createElement('div');
    foreground.setAttribute('data-confirm-dialog', 'true');
    document.body.appendChild(foreground);

    wrapper.findComponent(Dialog).vm.$emit('close');
    expect(wrapper.emitted('close')).toBeFalsy();

    foreground.remove();
    wrapper.findComponent(Dialog).vm.$emit('close');
    expect(wrapper.emitted('close')).toEqual([[]]);
    wrapper.unmount();
  });
});
