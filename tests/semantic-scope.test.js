import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { readAXScope, candidateDelta } from '../js/background/semantic-scope.js';
import { projectAX } from '../js/background/semantic-projection.js';
import { SemanticRuntime } from '../js/background/semantic-runtime.js';

const ax = (id, backend, role, name, parentId = '', childIds = []) => ({nodeId:id,backendDOMNodeId:backend,role:{value:role},name:{value:name},parentId,childIds});
const frame = {id:'frame',url:'https://example.test/',sessionId:'',documentGeneration:'document'};
function fixture() {
    const doc={...ax('doc',1,'RootWebArea','Products','',['row','outside']),frameId:'frame'};
    const row=ax('row',10,'row','','doc',['price','scope','sibling']);
    const price=ax('price',11,'StaticText','Widget $10','row');
    const scope=ax('scope',20,'group','Purchase','row',['ignored']);
    const ignored={...ax('ignored',21,'none','','scope',['buy']),ignored:true};
    const buy=ax('buy',22,'button','Buy','ignored');
    const sibling=ax('sibling',23,'button','Buy another','row');
    const outside=ax('outside',30,'button','Global action','doc');
    const replies=new Map([['row',[price,scope,sibling]],['scope',[ignored,buy]],['ignored',[buy]]]);
    const initial=[scope,row,doc,outside];
    const send=vi.fn(async(method,params)=> {
        if(method==='Accessibility.getAXNodeAndAncestors')return {nodes:initial};
        if(method==='Accessibility.getChildAXNodes')return {nodes:replies.get(params.id)||[]};
        throw new Error('unexpected protocol method');
    });
    return {send,initial,replies,doc,row,price,scope,ignored,buy,sibling};
}
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));

describe('explicit accessibility subtree scopes',()=>{
    it('walks ignored intermediates, keeps full entity context, and never offers outside candidates',async()=>{
        const f=fixture();
        const view=await readAXScope(f.send,{backendDOMNodeId:20,frameId:'frame'});
        expect(view.coverage.complete).toBe(true);
        expect(view.allowedNodeIDs).toEqual(new Set(['scope','ignored','buy']));
        expect(view.contextRootNodeID).toBe('row');expect(view.contextExpanded).toBe(true);
        expect(view.nodes.some(node=>node.nodeId==='price')).toBe(true);
        expect(view.nodes.some(node=>node.nodeId==='outside')).toBe(false);
        const projection=await projectAX(view.nodes,frame,'controls',{allowedNodeIDs:view.allowedNodeIDs});
        expect(projection.candidates.map(candidate=>candidate.name)).toEqual(['Buy']);
        expect(projection.candidates[0].context_relations).toContainEqual({role:'row',name:'Widget $10'});
        expect(f.send.mock.calls.every(([method])=>method!=='Accessibility.getFullAXTree')).toBe(true);
        expect(f.send.mock.calls.filter(([method])=>method==='Accessibility.getChildAXNodes').map(([,params])=>params.id)).toEqual(['row','scope','ignored']);
    });

    it('changing a contextual sibling invalidates selected candidate evidence without broadening eligibility',async()=>{
        const f=fixture();
        const first=await readAXScope(f.send,{backendDOMNodeId:20,frameId:'frame'});
        const before=await projectAX(first.nodes,frame,'controls',{allowedNodeIDs:first.allowedNodeIDs});
        f.price.name.value='Widget $30';
        const second=await readAXScope(f.send,{backendDOMNodeId:20,frameId:'frame'});
        const after=await projectAX(second.nodes,frame,'controls',{allowedNodeIDs:second.allowedNodeIDs});
        expect(before.evidence).not.toEqual(after.evidence);
        expect(after.candidates).toHaveLength(1);
    });

    it('reports missing descendants instead of claiming a complete no-match view',async()=>{
        const f=fixture();f.replies.set('scope',[]);
        const view=await readAXScope(f.send,{backendDOMNodeId:20,frameId:'frame'});
        expect(view.coverage.complete).toBe(false);
        expect(view.coverage.issues).toContainEqual({code:'scope_child_missing',node_id:'ignored'});
        expect(view.allowedNodeIDs).toEqual(new Set(['scope']));
    });

    it.each([{maxNodes:4},{maxDepth:1},{maxCalls:1}])('reports incomplete coverage at budget %j',async budget=>{
        const f=fixture();
        const view=await readAXScope(f.send,{backendDOMNodeId:20,frameId:'frame',...budget});
        expect(view.coverage.complete).toBe(false);expect(view.coverage.truncated).toBe(true);
        expect(view.coverage.omittedNodes).toBeGreaterThan(0);
        if(budget.maxNodes)expect(view.nodes.length).toBeLessThanOrEqual(budget.maxNodes);
        if(budget.maxCalls)expect(f.send).toHaveBeenCalledTimes(budget.maxCalls);
    });

    it('detects child cycles without following them indefinitely',async()=>{
        const f=fixture();f.ignored.childIds=['scope'];f.replies.set('ignored',[f.scope]);
        const view=await readAXScope(f.send,{backendDOMNodeId:20,frameId:'frame'});
        expect(view.coverage.complete).toBe(false);
        expect(view.coverage.issues.some(issue=>issue.code==='scope_child_cycle')).toBe(true);
        expect(f.send.mock.calls.length).toBeLessThan(8);
    });

    it('refuses a removed root and never falls back to the document',async()=>{
        const f=fixture();f.initial.splice(0,1);
        await expect(readAXScope(f.send,{backendDOMNodeId:20,frameId:'frame'})).rejects.toMatchObject({code:'scope_root_stale'});
        expect(f.send).toHaveBeenCalledOnce();
    });

    it('refuses a backend node from a different frame',async()=>{
        const f=fixture();f.doc.frameId='another-frame';
        await expect(readAXScope(f.send,{backendDOMNodeId:20,frameId:'frame'})).rejects.toMatchObject({code:'scope_frame_mismatch'});
        expect(f.send).toHaveBeenCalledOnce();
    });

    it('passes document guards around each read and aborts after a navigation',async()=>{
        const f=fixture();let current=true;
        const send=async(method,params)=>{const value=await f.send(method,params);if(method==='Accessibility.getChildAXNodes')current=false;return value;};
        const assertCurrent=()=>{if(!current)throw Object.assign(new Error('document changed'),{code:'stale_document'});};
        await expect(readAXScope(send,{backendDOMNodeId:20,frameId:'frame',assertCurrent})).rejects.toMatchObject({code:'stale_document'});
        expect(f.send).toHaveBeenCalledTimes(2);
    });

    it('rejects contradictory facts returned during one traversal',async()=>{
        const f=fixture();f.replies.set('row',[f.price,{...f.scope,name:{value:'Changed'}},f.sibling]);
        await expect(readAXScope(f.send,{backendDOMNodeId:20,frameId:'frame'})).rejects.toMatchObject({code:'scope_changed'});
    });

    it('stops ancestry at the selected frame root',async()=>{
        const f=fixture();f.doc.parentId='parent-iframe';f.initial.push({...ax('parent-iframe',40,'Iframe','','outer'),frameId:'outer-frame'});
        const view=await readAXScope(f.send,{backendDOMNodeId:20,frameId:'frame'});
        expect(view.coverage.complete).toBe(true);expect(view.nodes.some(node=>node.nodeId==='parent-iframe')).toBe(false);
        expect(view.nodes.find(node=>node.nodeId==='doc').parentId).toBeUndefined();
    });
});

describe('candidate deltas',()=>{
    it('includes changed facts and removals, independent of object-key ordering',()=>{
        const previous=[{id:'a',name:'One',role:'button'},{id:'b',name:'Two'}];
        const current=[{role:'button',name:'Changed',id:'a'},{id:'c',name:'Three'}];
        expect(candidateDelta(previous,current)).toEqual({upserted:current,removed:['b']});
        expect(candidateDelta([{id:'a',name:'One'}],[{name:'One',id:'a'}])).toEqual({upserted:[],removed:[]});
    });
});

function scopedRuntimeFixture() {
    const f=fixture();
    const selected={...frame,identity:'document',contextID:1};
    const session={valid:true,generation:'epoch',rootID:'frame',frames:new Map([['frame',selected]]),targets:new Map([['',{epoch:'target'}]]),index:new Map(),history:new Map(),dirty:new Set(),pending:new Set()};
    const runtime=Object.create(SemanticRuntime.prototype);
    runtime.runtime={sendDebugCommand:vi.fn((_debuggee,method,params)=>f.send(method,params))};
    runtime.refreshFrames=vi.fn(async()=>[[selected.id,selected.documentGeneration,'']]);
    runtime.withLease=async(_params,work)=>work(session);
    const params={tab_id:7,owner:'test',frame_id:'frame',kind:'controls',root_backend_dom_node_id:20};
    return {...f,runtime,session,selected,params};
}

describe('scope persistence and observation deltas',()=>{
    it('isolates unrelated changes but invalidates contextual evidence synchronously',async()=>{
        const f=scopedRuntimeFixture();
        const first=await f.runtime.observe(f.params);
        expect(first.full).toBe(true);expect(first.scope).toMatchObject({frame_id:'frame',root_backend_dom_node_id:20,context_root_backend_dom_node_id:10,context_expanded:true,complete:true,ax_calls:4});
        f.initial.find(node=>node.nodeId==='outside').name.value='Unrelated update';
        const same=await f.runtime.validate({...f.params,generation:first.generation,fingerprint:first.fingerprint});
        expect(same.fresh).toBe(true);
        f.price.name.value='Widget $99';
        const changed=await f.runtime.validate({...f.params,generation:first.generation,fingerprint:first.fingerprint});
        expect(changed.fresh).toBe(false);
        expect(changed.snapshot.candidates.map(candidate=>candidate.name)).toEqual(['Buy']);
    });

    it('returns only delta payloads for retained same-scope same-document bases',async()=>{
        const f=scopedRuntimeFixture();
        const first=await f.runtime.observe(f.params);
        f.price.name.value='Widget $30';
        const delta=await f.runtime.observe({...f.params,since:first.fingerprint});
        expect(delta.full).toBe(false);expect(delta.candidates).toBeUndefined();
        expect(delta.delta.base_fingerprint).toBe(first.fingerprint);
        expect(delta.delta.upserted).toHaveLength(1);expect(delta.delta.removed).toEqual([]);
        f.ignored.childIds=[];f.replies.set('scope',[f.ignored]);
        const removed=await f.runtime.observe({...f.params,since:delta.fingerprint});
        expect(removed.full).toBe(false);expect(removed.delta.upserted).toEqual([]);
        expect(removed.delta.removed).toEqual([first.candidates[0].id]);
    });

    it('falls back to full when base is absent, scope differs, or document changes',async()=>{
        const f=scopedRuntimeFixture();
        const first=await f.runtime.observe(f.params);
        expect((await f.runtime.observe({...f.params,since:'missing'})).full).toBe(true);
        expect((await f.runtime.observe({...f.params,kind:'all',since:first.fingerprint})).full).toBe(true);
        f.selected.documentGeneration='new-document';
        expect((await f.runtime.observe({...f.params,since:first.fingerprint})).full).toBe(true);
    });

    it('bounds retained history and never substitutes it for a boundary read',async()=>{
        const f=scopedRuntimeFixture();
        const first=await f.runtime.observe(f.params);
        for(let i=100;i<118;i++){f.price.name.value=`Widget $${i}`;await f.runtime.observe(f.params);}
        expect(f.session.history.size).toBeLessThanOrEqual(16);
        const calls=f.send.mock.calls.length;
        expect((await f.runtime.observe({...f.params,since:first.fingerprint})).full).toBe(true);
        expect(f.send.mock.calls.length).toBeGreaterThan(calls);
    });

    it('reports incomplete descendant coverage and rejects removed explicit roots',async()=>{
        const f=scopedRuntimeFixture();f.replies.set('scope',[]);
        const incomplete=await f.runtime.observe(f.params);
        expect(incomplete.coverage.truncated).toBe(true);expect(incomplete.coverage.omitted_nodes).toBeGreaterThan(0);
        expect(incomplete.coverage.frame_issues).toContainEqual({frame_id:'frame',reason:'scope_incomplete'});
        f.initial.splice(0,1);
        await expect(f.runtime.observe(f.params)).rejects.toMatchObject({code:'scope_root_stale'});
        expect(f.send.mock.calls.every(([method])=>method!=='Accessibility.getFullAXTree')).toBe(true);
    });
});

describe('dispatch rejection provenance',()=>{
    const setup=()=>{
        const selected={id:'frame',url:'https://example.test/',sessionId:'',documentGeneration:'document',contextID:1};
        const session={valid:true,generation:'epoch',rootID:'frame',frames:new Map([['frame',selected]])};
        const runtime=Object.create(SemanticRuntime.prototype);
        runtime.runtime={sendDebugCommand:vi.fn(async()=>({ok:true}))};
        runtime.lease=()=>({session,lease:{purpose:'execute'}});
        runtime.enqueue=(_session,work)=>work();runtime.refreshFrames=async()=>{};
        return runtime;
    };
    it('marks root/lease/ancestor guard failures before dispatch',async()=>{
        const runtime=setup();
        await expect(runtime.cdp({method:'Runtime.evaluate',expected_root_url:'https://different.test/'})).rejects.toMatchObject({code:'page_changed',data:{phase:'before_dispatch'}});
        expect(runtime.runtime.sendDebugCommand).not.toHaveBeenCalled();
        runtime.guardFramePoint=async()=>{throw Object.assign(new Error('overlay'),{code:'frame_owner_occluded'});};
        await expect(runtime.cdp({method:'Runtime.evaluate',frame_point:{x:1,y:2}})).rejects.toMatchObject({code:'frame_owner_occluded',data:{phase:'before_dispatch'}});
        expect(runtime.runtime.sendDebugCommand).not.toHaveBeenCalled();
        runtime.lease=()=>{throw Object.assign(new Error('expired'),{code:'invalid_lease'});};
        await expect(runtime.cdp({method:'Runtime.evaluate'})).rejects.toMatchObject({code:'invalid_lease',data:{phase:'before_dispatch'}});
    });
    it('does not label a requested command failure as a proven non-attempt',async()=>{
        const runtime=setup();
        const lost=Object.assign(new Error('reply lost'),{code:'browser_error'});
        runtime.runtime.sendDebugCommand.mockRejectedValue(lost);
        await expect(runtime.cdp({method:'Runtime.evaluate',command_params:{expression:'perform()'}})).rejects.toBe(lost);
        expect(lost.data).toBeUndefined();expect(runtime.runtime.sendDebugCommand).toHaveBeenCalledOnce();
    });
});
