/** Provider-free probes against the shared runtime and native gateway. */
import { decide } from '../../../runtime/execute';
import { questionValues, validateRequest, DEFAULT_LIMITS, type Adapter, type DecisionRequest, type DecisionResponse } from '../../../runtime/contract';
import { createJevAdapter } from '../../../runtime/jev';
import { evaluate } from '../../../../experience-prototypes/server/gateway';

const request: DecisionRequest = {schemaVersion:'1',requestId:'fixture',state:'fixture',questions:[{id:'q',kind:'boolean',prompt:'Is this a fixture?'}]};
const identity={adapter:'fixture',model:'fixture',revision:'pinned-one',local:true};
const response=():DecisionResponse=>({schemaVersion:'1',requestId:'fixture',status:'ok',decisions:[{questionId:'q',distribution:[{value:false,probability:0},{value:true,probability:1}],selected:true}],execution:identity,timing:{totalMs:1},issues:[]});
const adapter:Adapter={identity,limits:DEFAULT_LIMITS,decide:async()=>response()};
const result:Record<string,unknown>={};
try {result.nullRequest={response:await decide(adapter,null as unknown as DecisionRequest),threw:false};}
catch(error){result.nullRequest={threw:true,error:String(error)};}
const revision=await decide({...adapter,decide:async()=>({...response(),execution:{...identity,revision:'different-two'}})},request);
result.revisionIdentity={status:revision.status,configuredRevision:identity.revision,returnedRevision:revision.execution.revision};
const ordinal={id:'o',kind:'ordinal' as const,prompt:'Rate',min:100000000000000,max:100000000000001,step:1};
result.ordinalIdentity={requested:[ordinal.min,ordinal.max],values:questionValues(ordinal),requestIssues:validateRequest({...request,questions:[ordinal]})};
let calls=0;
try {await evaluate({state:'fixture',questions:{q:{type:'noul',instructions:'Fixture?'}}},{apiKey:'fixture',fetcher:(async()=>{calls++;return Response.json(null);}) as unknown as typeof fetch,wait:async()=>{}});}
catch(error){result.nullGatewayJson={calls,error:String(error)};}
const cancelled=new AbortController();
try {const output=await evaluate({state:'fixture',questions:{q:{type:'noul',instructions:'Fixture?'}}},{apiKey:'fixture',signal:cancelled.signal,fetcher:(async()=>{cancelled.abort();return Response.json({answers:{q:{type:'noul',noul:.8}}});}) as unknown as typeof fetch});result.gatewayCancellation={returnedSuccess:true,output};}
catch(error){result.gatewayCancellation={returnedSuccess:false,error:String(error)};}
// The runtime declares only byte limits; native transport imposes an additional instruction limit.
let promptCalls=0;
const longPrompt={...request,questions:[{id:'q',kind:'boolean' as const,prompt:'x'.repeat(12001)}]};
const jev=createJevAdapter('fixture',(async()=>{promptCalls++;return Response.json({answers:{q:{type:'noul',noul:.8}}});}) as unknown as typeof fetch);
const longResult=await decide(jev,longPrompt);
result.instructionLimit={advertisedLimits:jev.limits,requestIssues:validateRequest(longPrompt,jev.limits),status:longResult.status,issues:longResult.issues,providerCalls:promptCalls};
console.log(JSON.stringify(result,null,2));
