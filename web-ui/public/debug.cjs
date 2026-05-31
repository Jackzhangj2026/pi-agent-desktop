const http = require("http");
http.get("http://localhost:3003/app.js", (res) => {
  let data = "";
  res.on("data", (chunk) => data += chunk);
  res.on("end", () => {
    // Check for key functionality
    const checks = {
      "makeToggle autocompacttoggle": data.includes("makeToggle(el.autocompacttoggle,"),
      "makeToggle autoretrytoggle": data.includes("makeToggle(el.autoretrytoggle,"),
      "theme click handler": data.includes("addEventListener('click'"),
      "theme system": data.includes("= Theme System ="),
      "theme-opt query": data.includes("querySelectorAll('.theme-opt')"),
      "localStorage theme": data.includes("localStorage"),
    };
    Object.entries(checks).forEach(([k, v]) => console.log(v ? "OK" : "FAIL", k));
    console.log("JS length:", data.length);
  });
}).on("error", (e) => console.log("Error:", e.message));
