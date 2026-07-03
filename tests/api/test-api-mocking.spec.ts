/**
 * API Mocking Tests
 *
 * Comprehensive tests for the NetworkMocker utility covering basic CRUD mocking,
 * file-based mocks, dynamic responses, error handling, network conditions,
 * and advanced scenarios.
 */

import { test, expect } from "../../fixtures/index.js";
import { createMockDataFile, getMockTemplate } from "../../utils/network-mocking.js";
import * as fs from "fs";
import * as path from "path";

const API = "https://mock.test";

/**
 * Helper: navigate to a mock page that serves minimal HTML, then set content.
 * We route the base URL so page.goto succeeds, then use page.setContent
 * which keeps us on a proper origin so relative fetches work.
 */
async function setupPage(page: import("@playwright/test").Page, html: string) {
  // Serve a blank page at the mock origin so we have a real origin for fetch
  await page.route(`${API}/**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body></body></html>",
    });
  });
  await page.goto(API);
  // Now unroute the catch-all so our specific mocks take over
  await page.unroute(`${API}/**`);
  await page.setContent(html);
}

// ---------------------------------------------------------------------------
// Test: Basic API Mocking
// ---------------------------------------------------------------------------

test.describe("Basic API Mocking", { tag: "@api" }, () => {
  test("mock GET users list", async ({ page, apiMocker }) => {
    const users = [
      { id: 1, name: "Alice", email: "alice@example.com" },
      { id: 2, name: "Bob", email: "bob@example.com" },
    ];

    await apiMocker.mockGet(`${API}/api/users`, users);

    await setupPage(page, `
      <button id="load">Load Users</button>
      <div id="result"></div>
      <script>
        document.getElementById('load').addEventListener('click', async () => {
          const res = await fetch('${API}/api/users');
          const data = await res.json();
          document.getElementById('result').textContent = JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#load");
    await expect(page.locator("#result")).toContainText("Alice");
    await expect(page.locator("#result")).toContainText("Bob");
  });

  test("mock POST create user", async ({ page, apiMocker }) => {
    const created = { id: 3, name: "Charlie", email: "charlie@example.com" };

    await apiMocker.mockPost(`${API}/api/users`, created, { status: 201 });

    await setupPage(page, `
      <button id="create">Create User</button>
      <div id="result"></div>
      <script>
        document.getElementById('create').addEventListener('click', async () => {
          const res = await fetch('${API}/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Charlie', email: 'charlie@example.com' }),
          });
          const data = await res.json();
          document.getElementById('result').textContent = res.status + ':' + JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#create");
    await expect(page.locator("#result")).toContainText("201");
    await expect(page.locator("#result")).toContainText("Charlie");
  });

  test("mock PUT update user", async ({ page, apiMocker }) => {
    const updated = { id: 1, name: "Alice Updated", email: "alice_new@example.com" };

    await apiMocker.mockPut(`${API}/api/users/1`, updated);

    await setupPage(page, `
      <button id="update">Update User</button>
      <div id="result"></div>
      <script>
        document.getElementById('update').addEventListener('click', async () => {
          const res = await fetch('${API}/api/users/1', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Alice Updated' }),
          });
          const data = await res.json();
          document.getElementById('result').textContent = JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#update");
    await expect(page.locator("#result")).toContainText("Alice Updated");
  });

  test("mock DELETE user", async ({ page, apiMocker }) => {
    await apiMocker.mockDelete(`${API}/api/users/1`, { success: true }, { status: 200 });

    await setupPage(page, `
      <button id="delete">Delete User</button>
      <div id="result"></div>
      <script>
        document.getElementById('delete').addEventListener('click', async () => {
          const res = await fetch('${API}/api/users/1', { method: 'DELETE' });
          const data = await res.json();
          document.getElementById('result').textContent = res.status + ':' + JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#delete");
    await expect(page.locator("#result")).toContainText("200");
    await expect(page.locator("#result")).toContainText("success");
  });
});

// ---------------------------------------------------------------------------
// Test: File-Based Mocking
// ---------------------------------------------------------------------------

test.describe("File-Based Mocking", { tag: "@api" }, () => {
  const mockDir = path.resolve("test_artifacts/mock-data");
  const mockFile = path.join(mockDir, "products.json");

  test.beforeEach(() => {
    const products = [
      { id: 1, name: "Widget", price: 9.99 },
      { id: 2, name: "Gadget", price: 24.99 },
      { id: 3, name: "Doohickey", price: 14.99 },
    ];
    createMockDataFile(mockFile, products);
  });

  test.afterEach(() => {
    if (fs.existsSync(mockFile)) {
      fs.unlinkSync(mockFile);
    }
  });

  test("load products from JSON file", async ({ page, apiMocker }) => {
    await apiMocker.mockFromFile(`${API}/api/products`, mockFile);

    await setupPage(page, `
      <button id="load">Load Products</button>
      <div id="result"></div>
      <script>
        document.getElementById('load').addEventListener('click', async () => {
          const res = await fetch('${API}/api/products');
          const data = await res.json();
          document.getElementById('result').textContent = JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#load");
    await expect(page.locator("#result")).toContainText("Widget");
    await expect(page.locator("#result")).toContainText("Gadget");
    await expect(page.locator("#result")).toContainText("Doohickey");
  });
});

// ---------------------------------------------------------------------------
// Test: Dynamic Responses
// ---------------------------------------------------------------------------

test.describe("Dynamic Responses", { tag: "@api" }, () => {
  test("timestamp response", async ({ page, apiMocker }) => {
    await apiMocker.mockWithFunction(
      `${API}/api/time`,
      () => ({ timestamp: Date.now(), message: "Current server time" }),
      "GET",
    );

    await setupPage(page, `
      <button id="time">Get Time</button>
      <div id="result"></div>
      <script>
        document.getElementById('time').addEventListener('click', async () => {
          const res = await fetch('${API}/api/time');
          const data = await res.json();
          document.getElementById('result').textContent = JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#time");
    await expect(page.locator("#result")).toContainText("timestamp");
    await expect(page.locator("#result")).toContainText("Current server time");
  });

  test("search with query params", async ({ page, apiMocker }) => {
    await apiMocker.mockWithFunction(
      `${API}/api/search**`,
      (request) => {
        const url = new URL(request.url());
        const q = url.searchParams.get("q") || "";
        const items = [
          { name: "Apple" },
          { name: "Apricot" },
          { name: "Banana" },
        ];
        const filtered = items.filter((i) =>
          i.name.toLowerCase().includes(q.toLowerCase()),
        );
        return { query: q, results: filtered };
      },
      "GET",
    );

    await setupPage(page, `
      <input id="search" />
      <button id="go">Search</button>
      <div id="result"></div>
      <script>
        document.getElementById('go').addEventListener('click', async () => {
          const q = document.getElementById('search').value;
          const res = await fetch('${API}/api/search?q=' + encodeURIComponent(q));
          const data = await res.json();
          document.getElementById('result').textContent = JSON.stringify(data);
        });
      </script>
    `);

    await page.fill("#search", "ap");
    await page.click("#go");
    await expect(page.locator("#result")).toContainText("Apple");
    await expect(page.locator("#result")).toContainText("Apricot");
    await expect(page.locator("#result")).not.toContainText("Banana");
  });
});

// ---------------------------------------------------------------------------
// Test: Error Handling
// ---------------------------------------------------------------------------

test.describe("Error Handling", { tag: "@api" }, () => {
  test("500 server error", async ({ page, apiMocker }) => {
    const tmpl = getMockTemplate("serverError");
    await apiMocker.mockGet(`${API}/api/data`, tmpl.body, { status: tmpl.status });

    await setupPage(page, `
      <button id="load">Load</button>
      <div id="status"></div>
      <div id="result"></div>
      <script>
        document.getElementById('load').addEventListener('click', async () => {
          const res = await fetch('${API}/api/data');
          document.getElementById('status').textContent = String(res.status);
          const data = await res.json();
          document.getElementById('result').textContent = JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#load");
    await expect(page.locator("#status")).toHaveText("500");
    await expect(page.locator("#result")).toContainText("Internal Server Error");
  });

  test("404 not found", async ({ page, apiMocker }) => {
    const tmpl = getMockTemplate("notFound");
    await apiMocker.mockGet(`${API}/api/missing`, tmpl.body, { status: tmpl.status });

    await setupPage(page, `
      <button id="load">Load</button>
      <div id="status"></div>
      <div id="result"></div>
      <script>
        document.getElementById('load').addEventListener('click', async () => {
          const res = await fetch('${API}/api/missing');
          document.getElementById('status').textContent = String(res.status);
          const data = await res.json();
          document.getElementById('result').textContent = JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#load");
    await expect(page.locator("#status")).toHaveText("404");
    await expect(page.locator("#result")).toContainText("Not Found");
  });
});

// ---------------------------------------------------------------------------
// Test: Network Conditions
// ---------------------------------------------------------------------------

test.describe("Network Conditions", { tag: "@api" }, () => {
  test("slow network adds delay", async ({ page, apiMocker }) => {
    await apiMocker.mockGet(`${API}/api/slow-data`, { data: "loaded" });

    await setupPage(page, `
      <button id="load">Load</button>
      <div id="result"></div>
      <script>
        document.getElementById('load').addEventListener('click', async () => {
          const start = Date.now();
          const res = await fetch('${API}/api/slow-data');
          const elapsed = Date.now() - start;
          const data = await res.json();
          document.getElementById('result').textContent = elapsed + 'ms:' + JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#load");
    await expect(page.locator("#result")).toContainText("loaded");
  });

  test("network failure", async ({ page, apiMocker }) => {
    await apiMocker.simulateNetworkFailure(`${API}/api/fail`);

    await setupPage(page, `
      <button id="load">Load</button>
      <div id="result"></div>
      <script>
        document.getElementById('load').addEventListener('click', async () => {
          try {
            await fetch('${API}/api/fail');
            document.getElementById('result').textContent = 'unexpected-success';
          } catch (e) {
            document.getElementById('result').textContent = 'network-error';
          }
        });
      </script>
    `);

    await page.click("#load");
    await expect(page.locator("#result")).toHaveText("network-error");
  });

  test("offline mode", async ({ page, apiMocker }) => {
    await setupPage(page, `
      <button id="load">Load</button>
      <div id="result"></div>
      <script>
        document.getElementById('load').addEventListener('click', async () => {
          try {
            await fetch('${API}/api/anything');
            document.getElementById('result').textContent = 'unexpected-success';
          } catch (e) {
            document.getElementById('result').textContent = 'offline';
          }
        });
      </script>
    `);

    await apiMocker.simulateOffline();
    await page.click("#load");
    await expect(page.locator("#result")).toHaveText("offline");
  });
});

// ---------------------------------------------------------------------------
// Test: Advanced Scenarios
// ---------------------------------------------------------------------------

test.describe("Advanced Scenarios", { tag: "@api" }, () => {
  test("auth headers forwarded", async ({ page, apiMocker }) => {
    await apiMocker.mockWithFunction(
      `${API}/api/profile`,
      (request) => {
        const auth = request.headers()["authorization"] || "";
        if (auth === "Bearer valid-token") {
          return { user: "Phil", role: "admin" };
        }
        return { error: "Unauthorized" };
      },
      "GET",
    );

    await setupPage(page, `
      <button id="load">Load Profile</button>
      <div id="result"></div>
      <script>
        document.getElementById('load').addEventListener('click', async () => {
          const res = await fetch('${API}/api/profile', {
            headers: { 'Authorization': 'Bearer valid-token' },
          });
          const data = await res.json();
          document.getElementById('result').textContent = JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#load");
    await expect(page.locator("#result")).toContainText("Phil");
    await expect(page.locator("#result")).toContainText("admin");
  });

  test("auth error on invalid token", async ({ page, apiMocker }) => {
    await apiMocker.mockWithFunction(
      `${API}/api/profile`,
      (request) => {
        const auth = request.headers()["authorization"] || "";
        if (auth.startsWith("Bearer ") && auth !== "Bearer valid-token") {
          return { error: "Invalid token" };
        }
        return { error: "No token" };
      },
      "GET",
      { status: 401 },
    );

    await setupPage(page, `
      <button id="load">Load Profile</button>
      <div id="status"></div>
      <div id="result"></div>
      <script>
        document.getElementById('load').addEventListener('click', async () => {
          const res = await fetch('${API}/api/profile', {
            headers: { 'Authorization': 'Bearer bad-token' },
          });
          document.getElementById('status').textContent = String(res.status);
          const data = await res.json();
          document.getElementById('result').textContent = JSON.stringify(data);
        });
      </script>
    `);

    await page.click("#load");
    await expect(page.locator("#status")).toHaveText("401");
    await expect(page.locator("#result")).toContainText("Invalid token");
  });

  test("pagination", async ({ page, apiMocker }) => {
    const allItems = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      name: `Item ${i + 1}`,
    }));

    await apiMocker.mockWithFunction(
      `${API}/api/items**`,
      (request) => {
        const url = new URL(request.url());
        const pageNum = parseInt(url.searchParams.get("page") || "1", 10);
        const perPage = parseInt(url.searchParams.get("per_page") || "10", 10);
        const start = (pageNum - 1) * perPage;
        const items = allItems.slice(start, start + perPage);
        return {
          items,
          total: allItems.length,
          page: pageNum,
          per_page: perPage,
          total_pages: Math.ceil(allItems.length / perPage),
        };
      },
      "GET",
    );

    await setupPage(page, `
      <button id="page1">Page 1</button>
      <button id="page2">Page 2</button>
      <button id="page3">Page 3</button>
      <div id="result"></div>
      <script>
        async function loadPage(num) {
          const res = await fetch('${API}/api/items?page=' + num + '&per_page=10');
          const data = await res.json();
          document.getElementById('result').textContent = JSON.stringify(data);
        }
        document.getElementById('page1').addEventListener('click', () => loadPage(1));
        document.getElementById('page2').addEventListener('click', () => loadPage(2));
        document.getElementById('page3').addEventListener('click', () => loadPage(3));
      </script>
    `);

    // Page 1
    await page.click("#page1");
    await expect(page.locator("#result")).toContainText("Item 1");
    await expect(page.locator("#result")).toContainText("Item 10");

    // Page 2
    await page.click("#page2");
    await expect(page.locator("#result")).toContainText("Item 11");
    await expect(page.locator("#result")).toContainText("Item 20");

    // Page 3 — only 5 items
    await page.click("#page3");
    await expect(page.locator("#result")).toContainText("Item 21");
    await expect(page.locator("#result")).toContainText("Item 25");
  });

  test("comprehensive workflow", async ({ page, apiMocker }) => {
    const users = [{ id: 1, name: "Alice" }];
    await apiMocker.mockGet(`${API}/api/users`, users);
    await apiMocker.mockPost(`${API}/api/users`, { id: 2, name: "Bob" }, { status: 201 });
    await apiMocker.mockPut(`${API}/api/users/1`, { id: 1, name: "Alice Updated" });
    await apiMocker.mockDelete(`${API}/api/users/1`, { deleted: true });

    await setupPage(page, `
      <button id="list">List</button>
      <button id="create">Create</button>
      <button id="update">Update</button>
      <button id="remove">Delete</button>
      <div id="result"></div>
      <script>
        async function api(method, url, body) {
          const opts = { method, headers: { 'Content-Type': 'application/json' } };
          if (body) opts.body = JSON.stringify(body);
          const res = await fetch(url, opts);
          const data = await res.json();
          document.getElementById('result').textContent = res.status + ':' + JSON.stringify(data);
        }
        document.getElementById('list').addEventListener('click', () => api('GET', '${API}/api/users'));
        document.getElementById('create').addEventListener('click', () => api('POST', '${API}/api/users', { name: 'Bob' }));
        document.getElementById('update').addEventListener('click', () => api('PUT', '${API}/api/users/1', { name: 'Alice Updated' }));
        document.getElementById('remove').addEventListener('click', () => api('DELETE', '${API}/api/users/1'));
      </script>
    `);

    // List
    await page.click("#list");
    await expect(page.locator("#result")).toContainText("Alice");

    // Create
    await page.click("#create");
    await expect(page.locator("#result")).toContainText("201");
    await expect(page.locator("#result")).toContainText("Bob");

    // Update
    await page.click("#update");
    await expect(page.locator("#result")).toContainText("Alice Updated");

    // Delete
    await page.click("#remove");
    await expect(page.locator("#result")).toContainText("deleted");

    // Verify logging
    const requests = apiMocker.getRequestLog();
    expect(requests.length).toBeGreaterThanOrEqual(4);

    const responses = apiMocker.getResponseLog();
    expect(responses.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Test: Clearing Mocks
// ---------------------------------------------------------------------------

test.describe("Clearing Mocks", { tag: "@api" }, () => {
  test("cleared mocks no longer intercept requests", async ({ page, apiMocker }) => {
    await apiMocker.mockGet(`${API}/api/items`, [{ id: 1, name: "Widget" }]);

    await setupPage(page, "<div id='result'></div>");

    const fetchItems = () =>
      page.evaluate(async (url) => {
        try {
          const res = await fetch(url);
          return { ok: true, status: res.status, body: await res.text() };
        } catch {
          return { ok: false, status: 0, body: "" };
        }
      }, `${API}/api/items`);

    // Mock is active — request is intercepted and fulfilled
    const mocked = await fetchItems();
    expect(mocked.ok).toBe(true);
    expect(mocked.status).toBe(200);
    expect(mocked.body).toContain("Widget");
    expect(apiMocker.getRequestLog().length).toBe(1);

    await apiMocker.clearMocks();

    // Mock removed — the request goes to the (nonexistent) real network and fails
    const unmocked = await fetchItems();
    expect(unmocked.ok).toBe(false);

    // Logs were reset and the un-intercepted request was not logged
    expect(apiMocker.getRequestLog().length).toBe(0);
    expect(apiMocker.getResponseLog().length).toBe(0);
  });

  test("clearMocks removes function mocks and network condition routes", async ({
    page,
    apiMocker,
  }) => {
    await apiMocker.mockWithFunction(`${API}/api/dynamic`, () => ({ dynamic: true }));
    await apiMocker.simulateNetworkFailure(`${API}/api/broken`);

    await setupPage(page, "<div id='result'></div>");

    const fetchUrl = (url: string) =>
      page.evaluate(async (u) => {
        try {
          const res = await fetch(u);
          return { ok: true, status: res.status, body: await res.text() };
        } catch {
          return { ok: false, status: 0, body: "" };
        }
      }, url);

    const dynamic = await fetchUrl(`${API}/api/dynamic`);
    expect(dynamic.ok).toBe(true);
    expect(dynamic.body).toContain("dynamic");

    const broken = await fetchUrl(`${API}/api/broken`);
    expect(broken.ok).toBe(false);

    await apiMocker.clearMocks();

    // Both routes are gone — requests now fail at the real network layer
    const dynamicAfter = await fetchUrl(`${API}/api/dynamic`);
    expect(dynamicAfter.ok).toBe(false);
  });
});
