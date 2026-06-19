const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// ---------- КАРТА ----------
const MAP_WIDTH = 1600;
const MAP_HEIGHT = 600;

function groundHeight(x) {
  const nx = x / MAP_WIDTH;
  const base = MAP_HEIGHT * 0.7;
  const h1 = Math.sin(nx * Math.PI * 2) * 80;
  const h2 = Math.sin(nx * Math.PI * 4 + 1) * 40;
  return base - h1 - h2;
}

const FLAG_RED = { x: 200, y: groundHeight(200) };
const FLAG_BLUE = { x: MAP_WIDTH - 200, y: groundHeight(MAP_WIDTH - 200) };

// ---------- ТАНКИ ----------
const tankTypes = {
  T34: {
    id: "T34",
    name: "T34",
    hp: 1280,
    armor: 0.40,
    pen: 0.35,
    dmgMin: 200,
    dmgMax: 300,
    reload: 5,
    speedKmh: 30,
    gunDeg: 40,
    killsRequired: 0
  },
  KV2: {
    id: "KV2",
    name: "KV-2",
    hp: 1460,
    armor: 0.40,
    pen: 0.70,
    dmgMin: 400,
    dmgMax: 650,
    reload: 24,
    speedKmh: 12,
    gunDeg: 35,
    killsRequired: 0
  },
  CY100: {
    id: "CY100",
    name: "CY-100",
    hp: 1050,
    armor: 0.35,
    pen: 0.65,
    dmgMin: 300,
    dmgMax: 500,
    reload: 11,
    speedKmh: 20,
    gunDeg: 10,
    killsRequired: 0
  },
  CY100Y: {
    id: "CY100Y",
    name: "CY-100Y",
    hp: 1500,
    armor: 0.45,
    pen: 0.75,
    dmgMin: 400,
    dmgMax: 600,
    reload: 10,
    speedKmh: 21,
    gunDeg: 20,
    killsRequired: 20
  },
  TIGER: {
    id: "TIGER",
    name: "TIGER",
    hp: 2100,
    armor: 0.90,
    pen: 0.35,
    dmgMin: 200,
    dmgMax: 350,
    reload: 7,
    speedKmh: 12,
    gunDeg: 40,
    killsRequired: 45
  }
};

function kmhToPxPerSec(kmh) {
  return (kmh / 3.6) * 10;
}

// ---------- СОСТОЯНИЕ ----------
let tanks = []; // {id,socketId,team,typeId,x,y,hp,maxHp,reload,alive}
let nextTankId = 1;

let teamKills = {
  red: 0,
  blue: 0
};

const inputs = new Map(); // socketId -> {move}

// ---------- ВСПОМОГАТЕЛЬНОЕ ----------
function getSpawnPos(team) {
  const x = team === "red" ? FLAG_RED.x : FLAG_BLUE.x;
  const y = groundHeight(x);
  return { x, y };
}

function getTankBySocket(socketId) {
  return tanks.find(t => t.socketId === socketId && t.alive);
}

function canUseTank(team, typeId) {
  const tt = tankTypes[typeId];
  if (!tt) return false;
  const kills = teamKills[team] || 0;
  return kills >= tt.killsRequired;
}

function randomDamage(min, max) {
  return min + Math.random() * (max - min);
}

// ---------- СТРЕЛЬБА ----------
function rayHitTank(ray, tank) {
  const dx = Math.cos(ray.angle);
  const dy = Math.sin(ray.angle);

  const tx = tank.x;
  const t = (tx - ray.x) / dx;
  if (t < 0 || t > ray.maxDist) return null;

  const ry = ray.y + dy * t;
  const distY = Math.abs(ry - (tank.y - 20));
  if (distY > 30) return null;

  return { dist: t, hitX: tx, hitY: ry };
}

function rayHitsGround(ray) {
  const steps = 100;
  const dx = Math.cos(ray.angle) * (ray.maxDist / steps);
  const dy = Math.sin(ray.angle) * (ray.maxDist / steps);
  let x = ray.x;
  let y = ray.y;
  for (let i = 0; i < steps; i++) {
    const gh = groundHeight(x);
    if (y >= gh) {
      return { x, y };
    }
    x += dx;
    y += dy;
  }
  return null;
}

function handleFire(shooter, angleDeg) {
  const tt = tankTypes[shooter.typeId];
  if (!tt) return;
  if (shooter.reload > 0) return;

  const angleRad = angleDeg * Math.PI / 180;
  const maxDist = 2000;

  const ray = {
    x: shooter.x,
    y: shooter.y - 20,
    angle: angleRad,
    maxDist
  };

  const groundHit = rayHitsGround(ray);
  let maxRayDist = maxDist;
  if (groundHit) {
    const dx = groundHit.x - ray.x;
    const dy = groundHit.y - ray.y;
    maxRayDist = Math.sqrt(dx * dx + dy * dy);
  }

  let bestHit = null;
  let bestTank = null;

  tanks.forEach(t => {
    if (!t.alive) return;
    if (t.team === shooter.team) return;
    const hit = rayHitTank(ray, t);
    if (!hit) return;
    if (hit.dist > maxRayDist) return;
    if (!bestHit || hit.dist < bestHit.dist) {
      bestHit = hit;
      bestTank = t;
    }
  });

  let hitInfo = null;

  if (bestHit && bestTank) {
    const targetType = tankTypes[bestTank.typeId];
    const pen = tt.pen;
    const armor = targetType.armor;

    let penetrated = false;
    if (pen >= armor) {
      penetrated = true;
    } else {
      if (Math.random() < 0.5) penetrated = true;
    }

    if (penetrated) {
      const dmg = randomDamage(tt.dmgMin, tt.dmgMax);
      bestTank.hp -= dmg;
      hitInfo = {
        targetId: bestTank.id,
        dmg: Math.round(dmg),
        killed: bestTank.hp <= 0
      };

      if (bestTank.hp <= 0) {
        bestTank.alive = false;
        if (shooter.team === "red") teamKills.red++;
        else teamKills.blue++;
      }
    } else {
      hitInfo = {
        targetId: bestTank.id,
        dmg: 0,
        killed: false
      };
    }
  }

  shooter.reload = tt.reload;

  io.emit("shotRay", {
    fromX: ray.x,
    fromY: ray.y,
    angleDeg,
    maxDist: maxRayDist,
    team: shooter.team
  });

  if (hitInfo) {
    io.emit("hitInfo", hitInfo);
  }
}

// ---------- SOCKET.IO ----------
io.on("connection", socket => {
  console.log("Client connected", socket.id);

  socket.data.team = null;

  socket.emit("init", {
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    tankTypes,
    teamKills,
    flags: { red: FLAG_RED, blue: FLAG_BLUE }
  });

  socket.on("chooseTeam", team => {
    if (team !== "red" && team !== "blue") return;
    socket.data.team = team;
    socket.emit("teamChosen", team);
  });

  socket.on("spawnTank", typeId => {
    const team = socket.data.team;
    if (!team) return;
    if (!tankTypes[typeId]) return;
    if (!canUseTank(team, typeId)) return;

    const existing = getTankBySocket(socket.id);
    if (existing) existing.alive = false;

    const tt = tankTypes[typeId];
    const spawn = getSpawnPos(team);

    const tank = {
      id: nextTankId++,
      socketId: socket.id,
      team,
      typeId,
      x: spawn.x,
      y: spawn.y,
      hp: tt.hp,
      maxHp: tt.hp,
      reload: 0,
      alive: true
    };

    tanks.push(tank);
    socket.emit("spawnConfirmed", { tankId: tank.id });
  });

  socket.on("input", data => {
    const move = Math.max(-1, Math.min(1, data.move || 0));
    inputs.set(socket.id, { move });
  });

  socket.on("fire", data => {
    const tank = getTankBySocket(socket.id);
    if (!tank || !tank.alive) return;
    handleFire(tank, data.angleDeg);
  });

  socket.on("suicide", () => {
    const tank = getTankBySocket(socket.id);
    if (!tank || !tank.alive) return;
    tank.hp = 0;
    tank.alive = false;
    io.emit("hitInfo", {
      targetId: tank.id,
      dmg: tank.maxHp,
      killed: true
    });
  });

  socket.on("disconnect", () => {
    inputs.delete(socket.id);
    tanks = tanks.filter(t => t.socketId !== socket.id);
    console.log("Client disconnected", socket.id);
  });
});

// ---------- ИГРОВОЙ ЦИКЛ ----------
let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  tanks.forEach(t => {
    if (!t.alive) return;
    const inp = inputs.get(t.socketId) || { move: 0 };
    const tt = tankTypes[t.typeId];
    const speed = kmhToPxPerSec(tt.speedKmh);

    const dir = t.team === "red" ? 1 : -1;
    t.x += inp.move * speed * dt * dir;

    if (t.x < 50) t.x = 50;
    if (t.x > MAP_WIDTH - 50) t.x = MAP_WIDTH - 50;

    t.y = groundHeight(t.x);

    if (t.reload > 0) {
      t.reload -= dt;
      if (t.reload < 0) t.reload = 0;
    }
  });

  io.emit("state", {
    tanks,
    teamKills
  });
}, 50);

server.listen(PORT, () => {
  console.log("Tank server running on port", PORT);
});
