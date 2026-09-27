import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { projectAX } from '../js/background/semantic-projection.js';

const ax = (id, role, name, parentId = '', childIds = [], properties = []) => ({ nodeId: id, backendDOMNodeId: Number(id), role: { value: role }, name: { value: name }, parentId, childIds, properties });
const heading = (id, name, level, parentId) => ax(id, 'heading', name, parentId, [], [{ name: 'level', value: { value: level } }]);
const top = { id: 'top', url: 'https://listing.example/item', sessionId: '', documentGeneration: 'doc', parentID: '' };
const child = { id: 'pay', url: 'https://listing.example/pay', sessionId: '', documentGeneration: 'doc2', parentID: 'top' };

// Mirrors internal/jevdom/headings_test.go: the seller's name is only connected
// to "About this seller" through document order, not through any ancestor.
function listing() {
    const nodes = [
        ax('1', 'RootWebArea', 'Apple iPhone 13 | Listing', '', ['2', '3', '4', '11', '13', '14']),
        heading('2', 'Apple iPhone 13 128GB', 1, '1'),
        ax('3', 'StaticText', 'US $389.99', '1'),
        ax('4', 'generic', '', '1', ['5', '6', '9', '10']),
        heading('5', 'About this seller', 2, '4'),
        ax('6', 'generic', '', '4', ['7', '8']),
        ax('7', 'StaticText', 'tech_deals_42', '6'),
        ax('8', 'StaticText', 'Joined Mar 2015', '6'),
        heading('9', 'Contact', 3, '4'),
        ax('10', 'button', 'Contact seller', '4'),
        heading('11', 'Similar items', 2, '1'),
        ax('13', 'StaticText', 'Seller: renewed_direct', '1'),
        ax('14', 'region', 'Seller card', '1', ['15']),
        ax('15', 'link', 'Visit store', '14'),
    ];
    // Response order is shuffled; childIds carry document order.
    return [nodes[0], nodes[13], ...nodes.slice(1, 13)];
}
const find = (projection, name) => projection.candidates.find(candidate => candidate.name === name);
const headings = candidate => (candidate.context_relations || []).filter(item => item.role === 'heading').map(item => item.name);

beforeEach(() => vi.stubGlobal('crypto', webcrypto));

describe('semantic projection context', () => {
    it('labels candidates with the nearest preceding section heading in document order', async () => {
        const projection = await projectAX(listing(), top, 'all');
        const expected = {
            'US $389.99': ['Apple iPhone 13 128GB'], 'tech_deals_42': ['About this seller'], 'Joined Mar 2015': ['About this seller'],
            'Contact seller': ['Contact'], 'Seller: renewed_direct': ['Similar items'], 'Visit store': ['Similar items'],
            'About this seller': ['Apple iPhone 13 128GB'], 'Contact': ['About this seller'], 'Similar items': ['Apple iPhone 13 128GB'],
            'Apple iPhone 13 128GB': [],
        };
        for (const [name, want] of Object.entries(expected)) expect(headings(find(projection, name)), name).toEqual(want);
    });

    it('does not use the top-frame title as context, while child frames keep their document title', async () => {
        const page = await projectAX(listing(), top, 'controls');
        expect(find(page, 'Contact seller').context).toBeUndefined();
        expect(find(page, 'Visit store').context).toBe('Seller card');
        const frame = await projectAX([ax('100', 'RootWebArea', 'Secure checkout', '', ['101']), ax('101', 'button', 'Pay now', '100')], child, 'controls');
        expect(find(frame, 'Pay now').context).toBe('Secure checkout');
    });

    it('changes local evidence when a section heading changes', async () => {
        const before = await projectAX(listing(), top, 'text');
        const changed = listing().map(node => node.nodeId === '5' ? { ...node, name: { value: 'About another seller' } } : node);
        const after = await projectAX(changed, top, 'text');
        expect(JSON.stringify(after.evidence)).not.toBe(JSON.stringify(before.evidence));
        expect(headings(find(after, 'tech_deals_42'))).toEqual(['About another seller']);
    });
});

describe('dropdown option owners', () => {
    beforeEach(() => { vi.stubGlobal('crypto', webcrypto); });

    it('names the owning native select or ARIA combobox for each option', async () => {
        const nodes = [
            ax('1', 'RootWebArea', 'Checkout', '', ['2', '6']),
            ax('2', 'form', 'Shipping', '1', ['3', '4']),
            ax('3', 'combobox', 'Country', '2', ['30']),
            ax('30', 'MenuListPopup', '', '3', ['31', '32']),
            ax('31', 'option', 'Yes', '30', [], [{ name: 'selected', value: { value: true } }]),
            ax('32', 'option', 'No', '30'),
            ax('4', 'combobox', 'Gift wrap', '2', ['40']),
            ax('40', 'MenuListPopup', '', '4', ['41']),
            ax('41', 'option', 'Yes', '40'),
            ax('6', 'combobox', 'City', '1', ['60']),
            ax('60', 'listbox', 'City suggestions', '6', ['61']),
            ax('61', 'option', 'Albuquerque', '60'),
        ];
        const { candidates } = await projectAX(nodes, top, 'controls');
        const option = (name, owner) => candidates.find(c => c.role === 'option' && c.name === name && c.context_relations?.some(r => r.name === owner));
        expect(option('Yes', 'Country').context_relations[0]).toEqual({ role: 'select', name: 'Country' });
        expect(option('Yes', 'Gift wrap').context_relations[0]).toEqual({ role: 'select', name: 'Gift wrap' });
        expect(option('Yes', 'Country').id).not.toBe(option('Yes', 'Gift wrap').id);
        const suggestion = option('Albuquerque', 'City');
        expect(suggestion.context_relations).toEqual(expect.arrayContaining([{ role: 'listbox', name: 'City suggestions' }, { role: 'combobox', name: 'City' }]));
        expect(suggestion.context_relations.some(r => r.role === 'select')).toBe(false);
    });
});
