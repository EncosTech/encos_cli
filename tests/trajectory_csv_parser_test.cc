#include "src/trajectory_csv_parser.h"

#include <doctest.hpp>
#include <filesystem>
#include <fstream>
#include <string>

namespace emplay {
namespace {

class TempTrajectoryCsvFile {
public:
  explicit TempTrajectoryCsvFile(const std::string& content) {
    path_ = std::filesystem::temp_directory_path() /
            ("emplay_csv_test_" + std::to_string(reinterpret_cast<std::uintptr_t>(this)) + ".csv");
    std::ofstream file(path_);
    file << content;
  }

  ~TempTrajectoryCsvFile() { std::filesystem::remove(path_); }

  const std::filesystem::path& path() const { return path_; }

private:
  std::filesystem::path path_;
};

TEST_CASE("ParseTrajectoryCsv reads header motor list and samples") {
  const TempTrajectoryCsvFile file(
      "time,Ethercat:eth0:0:1,Ethercat:eth0:0:2\n"
      "0.0,1,2\n"
      "0.5,3,4\n"
      "1.0,5,6\n");

  const Trajectory trajectory = ParseTrajectoryCsv(file.path().string());
  REQUIRE(trajectory.motor_names == std::vector<std::string>{"Ethercat:eth0:0:1", "Ethercat:eth0:0:2"});
  REQUIRE(trajectory.samples.size() == 3U);
  CHECK(trajectory.samples[0].time_s == doctest::Approx(0.0));
  CHECK(trajectory.samples[1].positions_deg[0] == doctest::Approx(3.0f));
  CHECK(trajectory.samples[2].positions_deg[1] == doctest::Approx(6.0f));
}

TEST_CASE("ParseTrajectoryCsv rejects non-increasing time") {
  const TempTrajectoryCsvFile file(
      "time,Ethercat:eth0:0:1\n"
      "0.0,1\n"
      "0.0,2\n");

  CHECK_THROWS_WITH_AS(ParseTrajectoryCsv(file.path().string()), doctest::Contains("strictly increasing"),
                       std::runtime_error);
}

TEST_CASE("ParseTrajectoryCsv rejects rows with wrong column count") {
  const TempTrajectoryCsvFile file(
      "time,Ethercat:eth0:0:1,Ethercat:eth0:0:2\n"
      "0.0,1,2\n"
      "0.5,3\n");

  CHECK_THROWS_WITH_AS(ParseTrajectoryCsv(file.path().string()), doctest::Contains("expected 3 columns"),
                       std::runtime_error);
}

}  // namespace
}  // namespace emplay
