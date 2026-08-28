#include "csv_parser.h"

#include <cstdio>
#include <doctest.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>

namespace emzero {
namespace {

class TempCsvFile {
public:
  explicit TempCsvFile(const std::string& content) {
    path_ = std::filesystem::temp_directory_path() /
            ("emzero_csv_test_" + std::to_string(reinterpret_cast<std::uintptr_t>(this)) + ".csv");
    std::ofstream file(path_);
    file << content;
  }

  ~TempCsvFile() { std::filesystem::remove(path_); }

  const std::filesystem::path& path() const { return path_; }

private:
  std::filesystem::path path_;
};

TEST_CASE("ParseCsvConfig ignores full-line comments starting with #") {
  const TempCsvFile file(
      "# this is a comment\n"
      "motor,current,set_position\n"
      "Ethercat:eth0:0:1,-0.5,-160\n"
      "# another comment\n");

  const auto points = ParseCsvConfig(file.path().string());
  REQUIRE(points.size() == 1U);
  CHECK(points[0].connection.adapter_type == "Ethercat");
  CHECK(points[0].connection.adapter_id == "eth0");
  CHECK(points[0].connection.bus_id == 0);
  CHECK(points[0].connection.motor_id == 1);
  CHECK(points[0].current == doctest::Approx(-0.5f));
  CHECK(points[0].set_position_deg == doctest::Approx(-160.0f));
}

TEST_CASE("ParseCsvConfig ignores inline comments on header and data rows") {
  const TempCsvFile file(
      "motor,current,set_position  # header comment\n"
      "Ethercat:eth0:0:1,-0.5,-160  # first point\n"
      "Ethercat:eth0:0:1,0.5,160    # second point\n");

  const auto points = ParseCsvConfig(file.path().string());
  REQUIRE(points.size() == 2U);
  CHECK(points[0].current == doctest::Approx(-0.5f));
  CHECK(points[0].set_position_deg == doctest::Approx(-160.0f));
  CHECK(points[1].current == doctest::Approx(0.5f));
  CHECK(points[1].set_position_deg == doctest::Approx(160.0f));
}

TEST_CASE("ParseCsvConfig ignores empty lines and lines that become empty after stripping comments") {
  const TempCsvFile file(
      "\n"
      "motor,current,set_position\n"
      "\n"
      "#\n"
      "   # comment with leading whitespace\n"
      "Ethercat:eth0:0:1,-0.5,-160\n"
      "   \n");

  const auto points = ParseCsvConfig(file.path().string());
  REQUIRE(points.size() == 1U);
  CHECK(points[0].set_position_deg == doctest::Approx(-160.0f));
}

TEST_CASE("ParseCsvConfig skips malformed rows") {
  const TempCsvFile file(
      "motor,current,set_position\n"
      "Ethercat:eth0:0:1,-0.5\n"               // missing column
      "Ethercat:eth0:0:1,not_a_number,-160\n"  // invalid current
      "Ethercat:eth0:0:1,-0.5,-160\n");        // valid

  const auto points = ParseCsvConfig(file.path().string());
  REQUIRE(points.size() == 1U);
  CHECK(points[0].current == doctest::Approx(-0.5f));
  CHECK(points[0].set_position_deg == doctest::Approx(-160.0f));
}

}  // namespace
}  // namespace emzero
