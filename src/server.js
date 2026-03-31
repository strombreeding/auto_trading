import express from "express";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 8080;

// 프로젝트 루트 경로에 있는 proportion.json 경로 설정
const JSON_PATH = path.join(process.cwd(), "proportion.json");

/**
 * JSON 파일의 powerOn 상태를 업데이트하는 공통 함수
 */
const updatePowerStatus = (status) => {
  try {
    // 1. 루트 폴더에서 파일 읽기
    const data = fs.readFileSync(JSON_PATH, "utf8");
    const config = JSON.parse(data);

    // 2. 값 변경
    config.powerOn = status;

    // 3. 파일 다시 쓰기 (동기 방식)
    fs.writeFileSync(JSON_PATH, JSON.stringify(config, null, 2), "utf8");
    console.log(`[Success] powerOn이 ${status}로 변경되었습니다.`);
    return true;
  } catch (error) {
    console.error("[Error] 파일 처리 실패:", error.message);
    return false;
  }
};
/**
 * JSON 파일의 powerOn 상태를 업데이트하는 공통 함수
 */
const updateProfitStatus = (status) => {
  try {
    // 1. 루트 폴더에서 파일 읽기
    const data = fs.readFileSync(JSON_PATH, "utf8");
    const config = JSON.parse(data);

    // 2. 값 변경
    config.profitMode = status;

    // 3. 파일 다시 쓰기 (동기 방식)
    fs.writeFileSync(JSON_PATH, JSON.stringify(config, null, 2), "utf8");
    console.log(`[Success] profitMode가 ${status}로 변경되었습니다.`);
    return true;
  } catch (error) {
    console.error("[Error] 파일 처리 실패:", error.message);
    return false;
  }
};

// 라우트: /on
app.get("/on", (req, res) => {
  if (updatePowerStatus(true)) {
    res.json({ success: true, message: "Power ON" });
  } else {
    res.status(500).json({ success: false, message: "파일 업데이트 실패" });
  }
});

// 라우트: /off
app.get("/off", (req, res) => {
  if (updatePowerStatus(false)) {
    res.json({ success: true, message: "Power OFF" });
  } else {
    res.status(500).json({ success: false, message: "파일 업데이트 실패" });
  }
});
// 라우트: /profit/nnn
app.get("/profit:percent", (req, res) => {
  const { percent } = req.params;
  if (percent > 100)
    return res
      .status(500)
      .json({ success: false, message: "파일 업데이트 실패" });
  if (updateProfitStatus(percent)) {
    res.json({ success: true, message: `profitMode ${percent}` });
  } else {
    res.status(500).json({ success: false, message: "파일 업데이트 실패" });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(`대상 파일: ${JSON_PATH}`);
});
