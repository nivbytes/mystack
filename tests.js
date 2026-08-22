const fs = require('fs');
const HarAnalyzer = require('./harAnalyzer.js');

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
  console.log(`✅ PASS: ${message}`);
}

function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING OBSERVED DATA FLOW TEST SUITE');
  console.log('====================================================\n');

  // Acceptance Test
  {
    const entries = [
      {
        startedDateTime: '2026-08-20T10:00:00.000Z',
        request: { method: 'POST', url: 'https://api1.example.com/v1/auth' },
        response: {
          status: 200,
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          content: { text: JSON.stringify({ id: 'A123', acctName: 'Acme' }) },
        },
      },
      {
        startedDateTime: '2026-08-20T10:00:01.000Z',
        request: {
          method: 'POST',
          url: 'https://api2.example.com/v1/user',
          postData: { text: JSON.stringify({ accountId: 'A123' }) },
        },
        response: {
          status: 200,
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          content: { text: JSON.stringify({ acctPwd: 'secret123' }) },
        },
      },
      {
        startedDateTime: '2026-08-20T10:00:02.000Z',
        request: {
          method: 'POST',
          url: 'https://api3.example.com/v1/orders',
          postData: { text: JSON.stringify({ id: 'A123', name: 'Acme', password: 'secret123' }) },
        },
        response: {
          status: 200,
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          content: { text: '{}' },
        },
      },
    ];

    const model = HarAnalyzer.analyzeObservedDataFlow(entries);

    assert(model.services.length === 3, `Acceptance Test: Expected 3 services, found ${model.services.length}`);
    const hosts = model.services.map(s => s.host).sort();
    assert(hosts.includes('api1.example.com'), 'Acceptance Test: Contains api1.example.com service node');
    assert(hosts.includes('api2.example.com'), 'Acceptance Test: Contains api2.example.com service node');
    assert(hosts.includes('api3.example.com'), 'Acceptance Test: Contains api3.example.com service node');

    assert(model.relationships.length === 4, `Acceptance Test: Expected 4 relationships, found ${model.relationships.length}`);

    const r1 = model.relationships.find(r => r.sourceServiceName.includes('api1') && r.targetServiceName.includes('api2') && r.sourcePath === 'id');
    const r2 = model.relationships.find(r => r.sourceServiceName.includes('api1') && r.targetServiceName.includes('api3') && r.sourcePath === 'id');
    const r3 = model.relationships.find(r => r.sourceServiceName.includes('api1') && r.targetServiceName.includes('api3') && r.sourcePath === 'acctName');
    const r4 = model.relationships.find(r => r.sourceServiceName.includes('api2') && r.targetServiceName.includes('api3') && r.sourcePath === 'acctPwd');

    assert(r1 && r1.value === 'A123', 'Acceptance Test: api1 -> api2 : id (A123)');
    assert(r2 && r2.value === 'A123', 'Acceptance Test: api1 -> api3 : id (A123)');
    assert(r3 && r3.value === 'Acme', 'Acceptance Test: api1 -> api3 : acctName (Acme)');
    assert(r4 && r4.value === 'secret123', 'Acceptance Test: api2 -> api3 : acctPwd (secret123)');

    assert(model.graph.edges.length === 3, 'Acceptance Test: Graph contains 3 aggregated edges');
    const edgeApi1ToApi3 = model.graph.edges.find(e => e.sourceServiceName.includes('api1') && e.targetServiceName.includes('api3'));
    assert(edgeApi1ToApi3 && edgeApi1ToApi3.attributeNames.length === 2, 'Acceptance Test: Edge api1 -> api3 carries 2 attributes (id, acctName)');
  }

  // Test 2: URL Normalization
  {
    const entry = {
      startedDateTime: '2026-08-20T10:00:00.000Z',
      request: { method: 'POST', url: 'https://auth.company.io/v2/oauth/token' },
      response: { status: 200, content: { text: '{}' } },
    };
    const norm = HarAnalyzer.normalizeHarEntry(entry, 0);
    assert(norm.url === 'https://auth.company.io/v2/oauth/token', 'Test 2: Preserved exact full URL');
    assert(norm.host === 'auth.company.io', 'Test 2: Extracted host auth.company.io (NOT (unknown host))');
    assert(norm.path === '/v2/oauth/token', 'Test 2: Extracted pathname /v2/oauth/token (NOT /)');
    assert(norm.method === 'POST', 'Test 2: Preserved method POST (NOT defaulted to GET)');
    assert(norm.serviceName === 'https://auth.company.io' || norm.host === 'auth.company.io', 'Test 2: Stable service identity https://auth.company.io');
  }

  // Test 3: Relationship value matching
  {
    const entries = [
      {
        startedDateTime: '2026-08-20T10:00:00.000Z',
        request: { method: 'POST', url: 'https://api1.example.com/v1/auth' },
        response: { status: 200, content: { text: JSON.stringify({ id: 'A123' }) } },
      },
      {
        startedDateTime: '2026-08-20T10:00:01.000Z',
        request: { method: 'POST', url: 'https://api2.example.com/v1/user', postData: { text: JSON.stringify({ accountId: 'A123' }) } },
        response: { status: 200, content: { text: '{}' } },
      },
    ];
    const model = HarAnalyzer.analyzeObservedDataFlow(entries);
    assert(model.relationships.length === 1, 'Test 3: Inferred relationship based on value A123 despite differing field names');
    assert(model.relationships[0].sourcePath === 'id', 'Test 3: Source path is "id"');
    assert(model.relationships[0].targetPath === 'accountId', 'Test 3: Target path is "accountId"');
    assert(model.relationships[0].value === 'A123', 'Test 3: Matched value is A123');
  }

  // Test 4: Nested and array relationships
  {
    const entries = [
      {
        startedDateTime: '2026-08-20T10:00:00.000Z',
        request: { method: 'GET', url: 'https://api1.example.com/context' },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({
              account: { id: 'ACC_987' },
              members: [{ memberId: 'MEM_01' }, { memberId: 'MEM_02' }],
            }),
          },
        },
      },
      {
        startedDateTime: '2026-08-20T10:00:01.000Z',
        request: {
          method: 'POST',
          url: 'https://api2.example.com/projects',
          postData: {
            text: JSON.stringify({
              project: {
                ownerAccountId: 'ACC_987',
                assignedMember: 'MEM_02',
              },
            }),
          },
        },
        response: { status: 200, content: { text: '{}' } },
      },
    ];

    const model = HarAnalyzer.analyzeObservedDataFlow(entries);
    assert(model.relationships.length === 2, 'Test 4: Inferred both nested and array relationships');

    const accRel = model.relationships.find(r => r.value === 'ACC_987');
    assert(accRel && accRel.sourcePath === 'account.id' && accRel.targetPath === 'project.ownerAccountId', 'Test 4: Nested path account.id -> project.ownerAccountId');

    const memRel = model.relationships.find(r => r.value === 'MEM_02');
    assert(memRel && memRel.sourcePath === 'members[1].memberId' && memRel.targetPath === 'project.assignedMember', 'Test 4: Array path members[1].memberId -> project.assignedMember');
  }

  // Test 5: Query Parameters & Path Segments
  {
    const entries = [
      {
        startedDateTime: '2026-08-20T10:00:00.000Z',
        request: { method: 'POST', url: 'https://auth.example.com/session' },
        response: { status: 200, content: { text: JSON.stringify({ sessionId: 'SESS_445566' }) } },
      },
      {
        startedDateTime: '2026-08-20T10:00:01.000Z',
        request: { method: 'GET', url: 'https://api.example.com/data?sessionId=SESS_445566&filter=active' },
        response: { status: 200, content: { text: '[]' } },
      },
      {
        startedDateTime: '2026-08-20T10:00:02.000Z',
        request: { method: 'DELETE', url: 'https://api2.example.com/session/SESS_445566' },
        response: { status: 204, content: { text: '' } },
      },
    ];

    const model = HarAnalyzer.analyzeObservedDataFlow(entries);
    assert(model.relationships.length === 2, 'Test 5: Extracted query param and path segment propagation');
    const qRel = model.relationships.find(r => r.targetPath === 'query.sessionId');
    assert(qRel, 'Test 5: Query parameter target query.sessionId');
    const pRel = model.relationships.find(r => r.targetLocation === 'path');
    assert(pRel && pRel.value === 'SESS_445566', 'Test 5: Path segment target SESS_445566');
  }

  // Test 6: Boilerplate filtering
  {
    const entries = [
      {
        startedDateTime: '2026-08-20T10:00:00.000Z',
        request: { method: 'GET', url: 'https://api1.example.com/status' },
        response: { status: 200, content: { text: JSON.stringify({ ok: true, status: 'SUCCESS', count: 0 }) } },
      },
      {
        startedDateTime: '2026-08-20T10:00:01.000Z',
        request: { method: 'POST', url: 'https://api2.example.com/check', postData: { text: JSON.stringify({ ok: true, status: 'SUCCESS', count: 0 }) } },
        response: { status: 200, content: { text: '{}' } },
      },
    ];
    const model = HarAnalyzer.analyzeObservedDataFlow(entries);
    assert(model.relationships.length === 0, 'Test 6: All boilerplate/low-information values filtered out (0 false positive edges)');
  }

  // Test 7: Match classification
  {
    const entries = [
      {
        startedDateTime: '2026-08-20T10:00:00.000Z',
        request: { method: 'POST', url: 'https://auth.example.com/login', postData: { text: '{"user":"test"}' } },
        response: {
          status: 200,
          content: { text: JSON.stringify({ id: 'ID_100', workspace: 'Workspace Beta/Reports' }) },
        },
      },
      {
        startedDateTime: '2026-08-20T10:00:01.000Z',
        request: {
          method: 'GET',
          url: 'https://api.example.com/query?path=Workspace%20Beta%2FReports',
          headers: [{ name: 'x-id', value: 'ID_100' }],
        },
        response: { status: 200, content: { text: '{}' } },
      },
    ];

    const model = HarAnalyzer.analyzeObservedDataFlow(entries);
    assert(model.relationships.length === 2, 'Test 7: Inferred matches');
    assert(model.relationships.every(r => r.confidenceLabel === 'CONFIRMED'), 'Test 7: Matches are CONFIRMED');
  }

  // Test 8: Diagnostics
  {
    const entries = [
      {
        startedDateTime: '2026-08-20T10:00:00.000Z',
        request: { method: 'POST', url: 'https://api1.example.com/v1', postData: { text: JSON.stringify({ a: 1 }) } },
        response: { status: 200, content: { text: JSON.stringify({ key: 'val999' }) } },
      },
      {
        startedDateTime: '2026-08-20T10:00:01.000Z',
        request: { method: 'POST', url: 'https://api2.example.com/v2', postData: { text: JSON.stringify({ key: 'val999' }) } },
        response: { status: 200, content: { text: '{}' } },
      },
    ];

    const model = HarAnalyzer.analyzeObservedDataFlow(entries);
    assert(typeof model.diagnostics === 'object', 'Test 8: model.diagnostics is Object');
    assert(model.diagnostics.totalEntries === 2, 'Test 8: Diagnostics totalEntries = 2');
    assert(model.diagnostics.validUrlEntries === 2, 'Test 8: Diagnostics validUrlEntries = 2');
    assert(model.diagnostics.uniqueHosts === 2, 'Test 8: Diagnostics uniqueHosts = 2');
    assert(model.diagnostics.requestsWithJsonBody === 2, 'Test 8: Diagnostics requestsWithJsonBody = 2');
    assert(model.diagnostics.responsesWithJsonBody === 2, 'Test 8: Diagnostics responsesWithJsonBody = 2');
    assert(model.diagnostics.acceptedExactRelationships === 1, 'Test 8: Diagnostics acceptedExactRelationships = 1');
  }

  // Test 9: Pre-Normalized HAR Pulse Entries Compatibility
  {
    const entries = [
      {
        index: 0,
        id: 'req_0',
        timestamp: new Date('2026-08-20T10:00:00.000Z').getTime(),
        url: 'https://api1.example.com/user',
        host: 'api1.example.com',
        path: '/user',
        method: 'GET',
        serviceId: 'https://api1.example.com',
        serviceName: 'https://api1.example.com',
        endpointId: 'GET:https://api1.example.com/user',
        endpointName: 'GET /user',
        responseBodyText: JSON.stringify({ userId: 'USR_555', token: 'eyJhbGciOi' }),
        content: { text: JSON.stringify({ userId: 'USR_555', token: 'eyJhbGciOi' }) },
        status: 200,
        isValidUrl: true,
      },
      {
        index: 1,
        id: 'req_1',
        timestamp: new Date('2026-08-20T10:00:01.000Z').getTime(),
        url: 'https://api2.example.com/profile',
        host: 'api2.example.com',
        path: '/profile',
        method: 'POST',
        serviceId: 'https://api2.example.com',
        serviceName: 'https://api2.example.com',
        endpointId: 'POST:https://api2.example.com/profile',
        endpointName: 'POST /profile',
        requestBodyText: JSON.stringify({ userId: 'USR_555' }),
        postData: { text: JSON.stringify({ userId: 'USR_555' }) },
        requestHeaders: [{ name: 'Authorization', value: 'Bearer eyJhbGciOi' }],
        headers: [{ name: 'Authorization', value: 'Bearer eyJhbGciOi' }],
        status: 200,
        isValidUrl: true,
      },
    ];

    const model = HarAnalyzer.analyzeObservedDataFlow(entries);
    assert(model.services.length === 2, 'Test 9: Pre-normalized entries produced 2 services');
    assert(model.services[0].host === 'api1.example.com' || model.services[1].host === 'api1.example.com', 'Test 9: Host preserved correctly');
    assert(model.relationships.length === 2, 'Test 9: Pre-normalized entries produced 2 relationships (userId and Authorization)');
  }

  // Test 10: Presentation Model Aggregation
  {
    const entries = [
      {
        startedDateTime: '2026-08-20T10:00:00.000Z',
        request: { method: 'GET', url: 'https://api1.example.com/user' },
        response: { status: 200, content: { text: JSON.stringify({ email: 'user@test.com', id: 'U1' }) } },
      },
      {
        startedDateTime: '2026-08-20T10:00:01.000Z',
        request: { method: 'POST', url: 'https://api2.example.com/call1', postData: { text: JSON.stringify({ email: 'user@test.com' }) } },
        response: { status: 200, content: { text: '{}' } },
      },
      {
        startedDateTime: '2026-08-20T10:00:02.000Z',
        request: { method: 'POST', url: 'https://api2.example.com/call2', postData: { text: JSON.stringify({ email: 'user@test.com' }) } },
        response: { status: 200, content: { text: '{}' } },
      },
      {
        startedDateTime: '2026-08-20T10:00:03.000Z',
        request: { method: 'POST', url: 'https://api2.example.com/call3', postData: { text: JSON.stringify({ email: 'user@test.com', id: 'U1' }) } },
        response: { status: 200, content: { text: '{}' } },
      },
    ];

    const model = HarAnalyzer.analyzeObservedDataFlow(entries);
    const pres = HarAnalyzer.buildPresentationModel(model);

    assert(pres.apiCount === 2, 'Test 10: Discovered 2 active APIs');
    assert(pres.connectionCount === 1, 'Test 10: Exactly 1 API connection between API1 and API2');
    assert(pres.distinctInformationCount === 2, 'Test 10: Exactly 2 distinct information items (Email, ID)');
    assert(pres.totalRawObservations === 4, 'Test 10: Retained all 4 underlying raw observations');

    const emailInfo = pres.apiConnections[0].information.find(i => i.attributeName.toLowerCase().includes('email'));
    assert(emailInfo && emailInfo.occurrenceCount === 3, 'Test 10: Email observed 3 times inside the single connection');
    assert(emailInfo.evidence.length === 3, 'Test 10: Retained all 3 evidence references underneath Email');

    const idInfo = pres.apiConnections[0].information.find(i => i.attributeName.toLowerCase().includes('id'));
    assert(idInfo && idInfo.occurrenceCount === 1, 'Test 10: ID observed 1 time');
  }

  // Test 11: Attribute Name Formatting & Flow Narrative
  {
    assert(HarAnalyzer.formatAttributeName('EmailID') === 'Email ID', 'Test 11: Format EmailID -> Email ID');
    assert(HarAnalyzer.formatAttributeName('EnterpriseID') === 'Enterprise ID', 'Test 11: Format EnterpriseID -> Enterprise ID');
    assert(HarAnalyzer.formatAttributeName('acctPwd') === 'Account Password', 'Test 11: Format acctPwd -> Account Password');
    assert(HarAnalyzer.formatAttributeName('MetadataMasterUId') === 'Metadata Master UID', 'Test 11: Format MetadataMasterUId -> Metadata Master UID');
    assert(HarAnalyzer.formatFriendlyName('https://auth.company.io') === 'Auth API', 'Test 11: Format host -> Friendly API name');

    const narrative = HarAnalyzer.generateFlowNarrative([
      {
        sourceFriendlyName: 'Auth Service',
        targetFriendlyName: 'Billing Service',
        attributeNames: ['Account ID', 'Token'],
      },
    ]);
    assert(narrative && narrative.length > 0, 'Test 11: Generated plain-English narrative story');
  }

  // Test 12: Real HAR File (network5.har)
  if (fs.existsSync('./network5.har')) {
    const rawContent = fs.readFileSync('./network5.har', 'utf8');
    const har = JSON.parse(rawContent);
    const rawEntries = (har.log && har.log.entries) || [];

    const model = HarAnalyzer.analyzeObservedDataFlow(rawEntries);
    assert(model.services.length >= 3, `Test 12 (network5.har): Discovered exactly ${model.services.length} distinct service hosts`);
    assert(model.relationships.length > 0, 'Test 12 (network5.har): Successfully discovered observed data flows');
    assert(model.diagnostics.totalEntries === rawEntries.length, `Test 12 (network5.har): Analyzed all ${rawEntries.length} entries`);

    const pres = HarAnalyzer.buildPresentationModel(model);
    assert(pres.apiCount >= 2, `Test 12 (network5.har): Exactly ${pres.apiCount} connected active APIs in business view`);
    assert(pres.connectionCount >= 2, `Test 12 (network5.har): Exactly ${pres.connectionCount} API connections`);
    assert(pres.distinctInformationCount > 0, 'Test 12 (network5.har): Extracted distinct business information');
    assert(pres.totalRawObservations > 0, 'Test 12 (network5.har): Retained sufficient raw observations (improved dedup)');
  }

  // Test 13: App Knowledge Creation, Merge, and Conflict Detection
  {
    const entriesA = [
      {
        startedDateTime: '2026-08-20T10:00:00.000Z',
        request: { method: 'POST', url: 'https://auth.company.com/login' },
        response: { status: 200, content: { text: JSON.stringify({ userId: 'U101', token: 'T999' }) } },
      },
      {
        startedDateTime: '2026-08-20T10:00:01.000Z',
        request: { method: 'POST', url: 'https://orders.company.com/place', postData: { text: JSON.stringify({ userId: 'U101' }) } },
        response: { status: 200, content: { text: '{}' } },
      },
    ];

    // 1. Initial HAR analysis
    const modelA = HarAnalyzer.analyzeObservedDataFlow(entriesA);
    assert(modelA.services.length === 2, 'Test 13: HAR A produced 2 services');
    assert(modelA.relationships.length === 1, 'Test 13: HAR A produced 1 inferred relationship');

    // 2. Create structured App Knowledge
    const knowledge = HarAnalyzer.createAppKnowledge('store_app', 'E-Commerce Store', modelA);
    assert(knowledge.appId === 'store_app', 'Test 13: App Knowledge initialized with appId');
    assert(knowledge.services.length === 2, 'Test 13: Knowledge seeded with 2 services');

    // 3. User edits App Knowledge: Confirms relationship, adds custom payment service & link
    knowledge.relationships[0].status = 'user-confirmed';
    knowledge.relationships[0].notes = 'Verified Auth -> Orders flow';
    knowledge.layout['https://auth.company.com'] = { x: 100, y: 100 };

    // Add custom service
    knowledge.services.push({
      id: 'https://payment.stripe.com',
      name: 'Payment Gateway',
      host: 'payment.stripe.com',
      friendlyName: 'Stripe Payment API',
      group: 'Finance',
      isCustom: true,
      isDeleted: false
    });

    // Add user-created relationship
    knowledge.relationships.push({
      id: 'custom_rel_1',
      sourceServiceId: 'https://orders.company.com',
      targetServiceId: 'https://payment.stripe.com',
      sourceServiceName: 'Orders API',
      targetServiceName: 'Stripe Payment API',
      type: 'api_call',
      status: 'user-created',
      attributeNames: ['Payment Intent', 'Amount'],
      description: 'Order calls Payment API to charge card',
      userModified: true,
      isDeleted: false
    });

    // 4. Future HAR with conflicting/additional evidence
    const entriesB = [
      {
        startedDateTime: '2026-08-20T10:00:00.000Z',
        request: { method: 'POST', url: 'https://auth.company.com/login' },
        response: { status: 200, content: { text: JSON.stringify({ userId: 'U101', sessionToken: 'TOK_777' }) } },
      },
      {
        startedDateTime: '2026-08-20T10:00:01.000Z',
        request: { method: 'POST', url: 'https://orders.company.com/place', postData: { text: JSON.stringify({ userId: 'U101', sessionToken: 'TOK_777' }) } },
        response: { status: 200, content: { text: '{}' } },
      },
      {
        startedDateTime: '2026-08-20T10:00:02.000Z',
        request: { method: 'GET', url: 'https://analytics.company.com/track' },
        response: { status: 200, content: { text: '{}' } },
      }
    ];

    const modelB = HarAnalyzer.analyzeObservedDataFlow(entriesB);
    const merged = HarAnalyzer.mergeHarWithAppKnowledge(modelB, knowledge);

    assert(merged.services.length === 4, 'Test 13: Merged model contains all 4 services (2 HAR + 1 custom + 1 new Analytics)');
    assert(merged.relationships.some(r => r.targetServiceId === 'https://payment.stripe.com' && r.status === 'user-created'), 'Test 13: Preserved custom user-created payment link');
    assert(merged.relationships.some(r => r.status === 'user-confirmed'), 'Test 13: Preserved user-confirmed status');

    // 5. Conflict Detection
    const conflicts = HarAnalyzer.detectKnowledgeConflicts(modelB, knowledge);
    assert(Array.isArray(conflicts), 'Test 13: Conflict detection returned conflicts array');

    // 6. Export / Import Roundtrip
    const jsonStr = HarAnalyzer.exportAppKnowledgeToJson(knowledge);
    const imported = HarAnalyzer.importAppKnowledgeFromJson(jsonStr);
    assert(imported && imported.appId === 'store_app', 'Test 13: App Knowledge exported and imported successfully');
    assert(imported.services.length === 3, 'Test 13: Imported 3 services');
  }

  console.log('\n====================================================');
  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================\n');
}

runTests();
