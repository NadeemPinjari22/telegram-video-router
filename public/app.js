let channels = [];
let selectedChannel = null;
let selectedFiles = [];

let paused = false;
let stopped = false;
let running = false;


const $ = function (id) {
  return document.getElementById(id);
};


function log(message) {
  const box = $("logs");

  const time =
    new Date().toLocaleTimeString();

  box.innerHTML =
    "[" +
    time +
    "] " +
    escapeHtml(message) +
    "<br>" +
    box.innerHTML;
}


function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}


async function loadConfig() {

  try {

    const response =
      await fetch("/api/config");

    const data =
      await response.json();

    channels =
      data.channels || [];

    renderChannels();

    log("Router configuration loaded.");

    checkStatus();

  } catch (error) {

    log(
      "Configuration error: " +
      error.message
    );

  }
}


function renderChannels() {

  const box =
    $("channels");

  box.innerHTML = "";

  channels.forEach(function (channel) {

    const button =
      document.createElement("button");

    button.className =
      "channelButton";

    if (
      selectedChannel === channel.id
    ) {
      button.classList.add("selected");
    }

    button.innerHTML =
      "<strong>CHANNEL " +
      channel.id +
      "</strong><br>" +
      escapeHtml(channel.label) +
      "<br><small>" +
      (
        channel.configured
          ? "Configured"
          : "Not configured"
      ) +
      "</small>";

    button.onclick =
      function () {

        if (running) {
          log(
            "Stop the current upload before changing channel."
          );
          return;
        }

        selectedChannel =
          channel.id;

        renderChannels();

        $("selectedChannel").textContent =
          "Selected: " +
          channel.label;

        log(
          "Selected " +
          channel.label
        );
      };

    box.appendChild(button);

  });
}


$("videoInput").addEventListener(
  "change",
  function (event) {

    selectedFiles =
      Array.from(
        event.target.files || []
      );

    renderFiles();

  }
);


function renderFiles() {

  const box =
    $("fileList");

  box.innerHTML = "";

  $("totalCount").textContent =
    selectedFiles.length;

  $("successCount").textContent =
    "0";

  $("failedCount").textContent =
    "0";

  if (!selectedFiles.length) {

    box.innerHTML =
      '<div class="empty">' +
      "No videos selected" +
      "</div>";

    return;
  }


  selectedFiles.forEach(
    function (file, index) {

      const item =
        document.createElement("div");

      item.className =
        "fileItem";

      item.innerHTML =
        "<strong>" +
        escapeHtml(file.name) +
        "</strong>" +

        '<div class="progress">' +
        '<div id="progress-' +
        index +
        '" class="progressBar"></div>' +
        "</div>" +

        '<div id="status-' +
        index +
        '" class="fileStatus">' +
        "Waiting..." +
        "</div>";

      box.appendChild(item);

    }
  );
}


async function checkStatus() {

  try {

    const response =
      await fetch("/api/status");

    const data =
      await response.json();

    const status =
      $("connectionStatus");

    if (
      data.telegram &&
      data.telegram.connected &&
      data.telegram.authorized
    ) {

      status.textContent =
        "● Telegram Connected";

      status.className =
        "status online";

    } else {

      status.textContent =
        "● Telegram Not Connected";

      status.className =
        "status offline";

    }

  } catch (error) {

    $("connectionStatus").textContent =
      "● Server Error";

    $("connectionStatus").className =
      "status offline";

  }

}


$("reconnectButton").onclick =
  async function () {

    log(
      "Trying to reconnect Telegram..."
    );

    try {

      const response =
        await fetch(
          "/api/reconnect",
          {
            method: "POST"
          }
        );

      const data =
        await response.json();

      if (data.ok) {

        log(
          "Telegram connected successfully."
        );

      } else {

        log(
          "Reconnect failed: " +
          data.error
        );

      }

    } catch (error) {

      log(
        "Reconnect error: " +
        error.message
      );

    }

    checkStatus();

  };


function setFileStatus(
  index,
  text
) {

  const element =
    $("status-" + index);

  if (element) {
    element.textContent = text;
  }

}


function setProgress(
  index,
  percent
) {

  const element =
    $("progress-" + index);

  if (element) {

    element.style.width =
      percent + "%";

  }

}


async function uploadFile(
  file,
  index
) {

  const form =
    new FormData();

  form.append(
    "file",
    file
  );

  form.append(
    "channelId",
    selectedChannel
  );


  setFileStatus(
    index,
    "Uploading..."
  );


  try {

    const response =
      await fetch(
        "/api/upload",
        {
          method: "POST",
          body: form
        }
      );

    const data =
      await response.json();


    if (!response.ok) {

      setFileStatus(
        index,
        "Failed"
      );

      log(
        data.error ||
        "Upload request failed."
      );

      return false;
    }


    return await monitorJob(
      data.jobId,
      index
    );


  } catch (error) {

    setFileStatus(
      index,
      "Failed"
    );

    log(
      "Upload error: " +
      error.message
    );

    return false;
  }
}


async function monitorJob(
  jobId,
  index
) {

  while (!stopped) {

    try {

      const response =
        await fetch(
          "/api/jobs"
        );

      const data =
        await response.json();

      const job =
        (data.jobs || []).find(
          function (item) {
            return item.id === jobId;
          }
        );


      if (job) {

        setProgress(
          index,
          job.progress || 0
        );

        setFileStatus(
          index,
          job.message ||
          job.status
        );


        if (
          job.status ===
          "success"
        ) {

          setProgress(
            index,
            100
          );

          setFileStatus(
            index,
            "Success ✓"
          );

          return true;
        }


        if (
          job.status ===
          "failed"
        ) {

          setFileStatus(
            index,
            "Failed ✗"
          );

          log(
            "Upload failed: " +
            (job.error || "Unknown error")
          );

          return false;
        }

      }

    } catch (error) {

      log(
        "Status check error: " +
        error.message
      );

    }

    await wait(1000);

  }

  return false;
}


async function waitIfPaused() {

  while (
    paused &&
    !stopped
  ) {

    await wait(300);

  }

}


$("startButton").onclick =
  async function () {

    if (running) {
      return;
    }


    if (!selectedChannel) {

      alert(
        "Please select a channel first."
      );

      return;
    }


    if (!selectedFiles.length) {

      alert(
        "Please select videos first."
      );

      return;
    }


    running = true;
    paused = false;
    stopped = false;


    let success = 0;
    let failed = 0;


    log(
      "Upload started."
    );


    for (
      let i = 0;
      i < selectedFiles.length;
      i++
    ) {

      if (stopped) {
        break;
      }


      await waitIfPaused();


      if (stopped) {
        break;
      }


      const file =
        selectedFiles[i];


      log(
        "Uploading: " +
        file.name
      );


      const result =
        await uploadFile(
          file,
          i
        );


      if (result) {

        success++;

      } else {

        failed++;

      }


      $("successCount")
        .textContent = success;

      $("failedCount")
        .textContent = failed;


      if (
        i <
        selectedFiles.length - 1 &&
        !stopped
      ) {

        log(
          "Waiting 2.5 seconds..."
        );

        await wait(2500);

      }

    }


    running = false;


    if (stopped) {

      log(
        "Upload stopped."
      );

    } else {

      log(
        "Finished. Success: " +
        success +
        " | Failed: " +
        failed
      );

    }

  };


$("pauseButton").onclick =
  function () {

    if (!running) {
      return;
    }

    paused = true;

    log(
      "Upload paused."
    );

  };


$("resumeButton").onclick =
  function () {

    if (!running) {
      return;
    }

    paused = false;

    log(
      "Upload resumed."
    );

  };


$("stopButton").onclick =
  function () {

    if (!running) {
      return;
    }

    stopped = true;
    paused = false;

    log(
      "Stop requested."
    );

  };


$("clearButton").onclick =
  function () {

    if (running) {

      log(
        "Stop upload before clearing."
      );

      return;
    }


    selectedFiles = [];

    $("videoInput").value = "";

    $("fileList").innerHTML =
      '<div class="empty">' +
      "No videos selected" +
      "</div>";

    $("totalCount").textContent =
      "0";

    $("successCount").textContent =
      "0";

    $("failedCount").textContent =
      "0";

    log(
      "Queue cleared."
    );

  };


loadConfig();

setInterval(
  checkStatus,
  10000
);
