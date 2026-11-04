// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0
// Test app with planted runtime problems. Do not use as a reference.

async function loadUsers() {
  const res = await fetch("/api/users");
  const users = await res.json();
  document.getElementById("users").textContent = users.map((u) => u.name + " <" + u.email + ">").join(", ");
}

async function loadStats() {
  await fetch("/api/stats");
}

async function login(event) {
  event.preventDefault();
  const form = event.target;
  const email = form.elements.email.value;
  const password = form.elements.password.value;
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  localStorage.setItem("auth_token", data.token);
  console.log("logged in as", email);
  document.getElementById("status").textContent = "ok";
}

loadUsers();
loadStats();
document.getElementById("login").addEventListener("submit", login);
