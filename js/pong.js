// Easter egg: Pong. Opens from the footer, plays against a simple AI.

(function () {
  "use strict";

  var openBtn = document.getElementById("pong-open");
  var modal = document.getElementById("pong-modal");
  var closeBtn = document.getElementById("pong-close");
  var scoreEl = document.getElementById("pong-score");
  var canvas = document.getElementById("pong-canvas");
  if (!openBtn || !modal || !canvas) return;

  var ctx = canvas.getContext("2d");
  var W = canvas.width;
  var H = canvas.height;

  var styles = getComputedStyle(document.documentElement);
  var COL_BG = "#1A1D21";
  var COL_FG = (styles.getPropertyValue("--bg") || "#F6F6F3").trim();
  var COL_ACCENT = (styles.getPropertyValue("--accent") || "#44708F").trim();
  var COL_DIM = "#3A4048";

  var PADDLE_H = 72;
  var PADDLE_W = 10;
  var BALL_R = 6;

  var state, rafId = null, lastTime = 0;

  function resetBall(direction) {
    var angle = (Math.random() * 0.5 - 0.25) * Math.PI;
    state.ball = {
      x: W / 2,
      y: H / 2,
      vx: Math.cos(angle) * 300 * direction,
      vy: Math.sin(angle) * 300
    };
  }

  function newGame() {
    state = {
      playerY: H / 2 - PADDLE_H / 2,
      aiY: H / 2 - PADDLE_H / 2,
      playerScore: 0,
      aiScore: 0,
      running: false,
      keys: { up: false, down: false }
    };
    resetBall(Math.random() < 0.5 ? -1 : 1);
    updateScore();
    draw();
  }

  function updateScore() {
    scoreEl.textContent = state.playerScore + " : " + state.aiScore;
  }

  function step(dt) {
    // Keyboard paddle movement
    if (state.keys.up) state.playerY -= 380 * dt;
    if (state.keys.down) state.playerY += 380 * dt;
    state.playerY = Math.max(0, Math.min(H - PADDLE_H, state.playerY));

    // AI tracks the ball, capped speed so it can be beaten
    var target = state.ball.y - PADDLE_H / 2;
    var diff = target - state.aiY;
    var maxMove = 260 * dt;
    state.aiY += Math.max(-maxMove, Math.min(maxMove, diff));
    state.aiY = Math.max(0, Math.min(H - PADDLE_H, state.aiY));

    var b = state.ball;
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Walls
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }
    if (b.y > H - BALL_R) { b.y = H - BALL_R; b.vy = -Math.abs(b.vy); }

    // Player paddle (left)
    if (b.x - BALL_R < 18 + PADDLE_W && b.x > 18 && b.vx < 0 &&
        b.y > state.playerY - BALL_R && b.y < state.playerY + PADDLE_H + BALL_R) {
      b.x = 18 + PADDLE_W + BALL_R;
      bounce(b, state.playerY);
      b.vx = Math.abs(b.vx);
    }

    // AI paddle (right)
    if (b.x + BALL_R > W - 18 - PADDLE_W && b.x < W - 18 && b.vx > 0 &&
        b.y > state.aiY - BALL_R && b.y < state.aiY + PADDLE_H + BALL_R) {
      b.x = W - 18 - PADDLE_W - BALL_R;
      bounce(b, state.aiY);
      b.vx = -Math.abs(b.vx);
    }

    // Scoring
    if (b.x < -BALL_R * 2) { state.aiScore++; updateScore(); resetBall(1); }
    if (b.x > W + BALL_R * 2) { state.playerScore++; updateScore(); resetBall(-1); }
  }

  function bounce(b, paddleY) {
    // Angle depends on where the ball hits the paddle; speed up slightly
    var rel = (b.y - (paddleY + PADDLE_H / 2)) / (PADDLE_H / 2);
    var speed = Math.min(Math.hypot(b.vx, b.vy) * 1.04, 620);
    var angle = rel * 0.85; // max ~49 degrees
    b.vy = Math.sin(angle) * speed;
    b.vx = Math.cos(angle) * speed * (b.vx < 0 ? -1 : 1);
  }

  function draw() {
    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, 0, W, H);

    // Center line
    ctx.strokeStyle = COL_DIM;
    ctx.setLineDash([6, 10]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 12);
    ctx.lineTo(W / 2, H - 12);
    ctx.stroke();
    ctx.setLineDash([]);

    // Paddles
    ctx.fillStyle = COL_FG;
    ctx.fillRect(18, state.playerY, PADDLE_W, PADDLE_H);
    ctx.fillRect(W - 18 - PADDLE_W, state.aiY, PADDLE_W, PADDLE_H);

    // Ball
    ctx.fillStyle = COL_ACCENT;
    ctx.beginPath();
    ctx.arc(state.ball.x, state.ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();

    if (!state.running) {
      ctx.fillStyle = COL_FG;
      ctx.font = "600 15px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Space or tap to play", W / 2, H / 2 - 24);
    }
  }

  function loop(time) {
    var dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;
    if (state.running) step(dt);
    draw();
    rafId = requestAnimationFrame(loop);
  }

  function toCanvasY(clientY) {
    var rect = canvas.getBoundingClientRect();
    return ((clientY - rect.top) / rect.height) * H;
  }

  // ----- Input -----
  canvas.addEventListener("mousemove", function (e) {
    state.playerY = Math.max(0, Math.min(H - PADDLE_H, toCanvasY(e.clientY) - PADDLE_H / 2));
  });

  canvas.addEventListener("touchmove", function (e) {
    e.preventDefault();
    state.playerY = Math.max(0, Math.min(H - PADDLE_H, toCanvasY(e.touches[0].clientY) - PADDLE_H / 2));
  }, { passive: false });

  canvas.addEventListener("click", function () { state.running = !state.running; });
  canvas.addEventListener("touchend", function (e) {
    e.preventDefault();
    state.running = !state.running;
  });

  function onKeyDown(e) {
    if (e.key === "ArrowUp") { state.keys.up = true; e.preventDefault(); }
    else if (e.key === "ArrowDown") { state.keys.down = true; e.preventDefault(); }
    else if (e.key === " ") { state.running = !state.running; e.preventDefault(); }
    else if (e.key === "Escape") { close(); }
  }
  function onKeyUp(e) {
    if (e.key === "ArrowUp") state.keys.up = false;
    if (e.key === "ArrowDown") state.keys.down = false;
  }

  // ----- Open / close -----
  function open() {
    modal.hidden = false;
    newGame();
    lastTime = performance.now();
    rafId = requestAnimationFrame(loop);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    closeBtn.focus();
  }

  function close() {
    modal.hidden = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    openBtn.focus();
  }

  openBtn.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  modal.addEventListener("click", function (e) {
    if (e.target === modal) close();
  });
})();
