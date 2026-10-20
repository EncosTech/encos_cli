#include <encos/adapter/adapter_extend.h>

#include <argparse/argparse.hpp>
#include <doctest.hpp>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

#include "src/cli/adapter_cli_utils.h"
#include "src/cli/bench.h"
#include "src/cli/help_text.h"
#include "src/cli/play.h"
#include "src/cli/stress.h"

namespace {

std::string HelpOf(const argparse::ArgumentParser& parser) {
  std::ostringstream output;
  output << parser;
  return output.str();
}

}  // namespace

TEST_CASE("Timing options only materialize the fields that were given") {
  const AdapterTimingOptions none;
  CHECK(none.Empty());
  CHECK(none.ToExtend().empty());
  CHECK(none.ToExtend().dump() == "{}");

  AdapterTimingOptions bitrate_only;
  bitrate_only.bitrate = 500000;
  const auto bitrate_extend = bitrate_only.ToExtend();
  CHECK_FALSE(bitrate_only.Empty());
  CHECK(bitrate_extend.size() == 1U);
  CHECK(bitrate_extend.at("bitrate") == 500000);
  // 未给出的字段绝不能进信封：否则 CLI 的默认值会覆盖各适配器自己的插件默认值
  CHECK(bitrate_extend.find("sample_point") == bitrate_extend.end());
  CHECK(bitrate_extend.find("dbitrate") == bitrate_extend.end());
  CHECK(bitrate_extend.find("dsample_point") == bitrate_extend.end());

  AdapterTimingOptions sample_point_only;
  sample_point_only.sample_point = 0.875;
  // 信封里的键名用下划线，与选项名不同
  CHECK(sample_point_only.ToExtend().dump().find("sample_point") != std::string::npos);
  CHECK(sample_point_only.ToExtend().dump().find("--sample-point") == std::string::npos);
}

TEST_CASE("Timing option validation rejects out-of-range values") {
  const auto rejects = [](const AdapterTimingOptions& options) {
    CHECK_THROWS_AS(options.Validate(), std::runtime_error);
  };

  AdapterTimingOptions options;
  options.bitrate = 0;
  rejects(options);
  options = {};
  options.bitrate = -1;
  rejects(options);
  options = {};
  options.dbitrate = 0;
  rejects(options);
  options = {};
  options.sample_point = 0.0;
  rejects(options);
  options = {};
  options.sample_point = 1.5;
  rejects(options);
  options = {};
  options.dsample_point = 2.0;
  rejects(options);

  // 边界值 1.0 合法
  options = {};
  options.sample_point = 1.0;
  CHECK_NOTHROW(options.Validate());
}

TEST_CASE("Timing flags are stripped from either position and other tokens keep their order") {
  {
    std::vector<std::string> arguments{"--bitrate", "500000", "Can:can0", "--canfd"};
    const auto options = StripAdapterTimingFlags(arguments);
    CHECK(options.bitrate == std::optional<int>(500000));
    REQUIRE(arguments.size() == 2U);
    CHECK(arguments[0] == "Can:can0");
    CHECK(arguments[1] == "--canfd");
  }
  {
    std::vector<std::string> arguments{"Can:can0", "kt", "--sample-point", "0.875"};
    const auto options = StripAdapterTimingFlags(arguments);
    CHECK(options.sample_point == std::optional<double>(0.875));
    REQUIRE(arguments.size() == 2U);
    CHECK(arguments[0] == "Can:can0");
    CHECK(arguments[1] == "kt");
  }
  {
    // argparse 两种写法都接受，B 族必须同样支持 `=` 形式
    std::vector<std::string> arguments{"--dbitrate=2000000", "Can:can0"};
    const auto options = StripAdapterTimingFlags(arguments);
    CHECK(options.dbitrate == std::optional<int>(2000000));
    REQUIRE(arguments.size() == 1U);
    CHECK(arguments[0] == "Can:can0");
  }
  {
    // 含 '=' 的非选项 token（RelayWs 连接串的查询参数）必须原样保留
    std::vector<std::string> arguments{"slcan:@http://host:8080?AdapterName=x"};
    const auto options = StripAdapterTimingFlags(arguments);
    CHECK(options.Empty());
    REQUIRE(arguments.size() == 1U);
    CHECK(arguments[0] == "slcan:@http://host:8080?AdapterName=x");
  }
}

TEST_CASE("Malformed timing flags are rejected") {
  {
    std::vector<std::string> arguments{"--bitrate"};
    CHECK_THROWS_AS(StripAdapterTimingFlags(arguments), std::runtime_error);
  }
  {
    std::vector<std::string> arguments{"--bitrate", "500000", "--bitrate", "250000"};
    CHECK_THROWS_AS(StripAdapterTimingFlags(arguments), std::runtime_error);
  }
  {
    std::vector<std::string> arguments{"--bitrate", "abc"};
    CHECK_THROWS_AS(StripAdapterTimingFlags(arguments), std::runtime_error);
  }
  {
    // 取值越界由 Validate 兜住（正数波特率、(0,1] 采样点）
    std::vector<std::string> arguments{"--bitrate", "0"};
    CHECK_THROWS_AS(StripAdapterTimingFlags(arguments), std::runtime_error);
  }
  {
    std::vector<std::string> arguments{"--sample-point", "1.5"};
    CHECK_THROWS_AS(StripAdapterTimingFlags(arguments), std::runtime_error);
  }
}

TEST_CASE("ReadAdapterTimingOptions reads what argparse parsed") {
  {
    argparse::ArgumentParser parser("cmd");
    AddAdapterTimingArguments(parser);
    parser.parse_args({"cmd", "--bitrate", "250000"});
    const auto options = ReadAdapterTimingOptions(parser);
    CHECK(options.bitrate == std::optional<int>(250000));
    CHECK_FALSE(options.dbitrate.has_value());
    CHECK_FALSE(options.sample_point.has_value());
    CHECK_FALSE(options.dsample_point.has_value());
  }
  {
    argparse::ArgumentParser parser("cmd");
    AddAdapterTimingArguments(parser);
    parser.parse_args({"cmd"});
    CHECK(ReadAdapterTimingOptions(parser).Empty());
  }
}

TEST_CASE("The built envelope is accepted by the driver's extend parser") {
  AdapterTimingOptions options;
  options.bitrate = 500000;
  options.sample_point = 0.875;

  const auto extend = encos::AdapterExtend::Parse(options.ToExtend().dump());
  CHECK_FALSE(extend.Empty());
  CHECK(extend.DeclaredBuses().empty());
  const auto scope = extend.Scope(0, 0);
  CHECK(scope.at("bitrate") == 500000);
  CHECK(scope.at("sample_point").get<double>() == doctest::Approx(0.875));
}

TEST_CASE("Every command help lists the CAN timing options") {
  const std::vector<std::string> helps = {
      motor_cli::BuildTuiHelp(),     motor_cli::BuildScanHelp(),  motor_cli::BuildConfigHelp(),
      motor_cli::BuildControlHelp(), motor_cli::BuildImuHelp(),   motor_cli::BuildBatteryHelp(),
      motor_cli::BuildPmsHelp(),     motor_cli::BuildGloveHelp(),
  };
  for (const auto& help : helps) {
    CHECK(help.find("--bitrate") != std::string::npos);
    CHECK(help.find("--dbitrate") != std::string::npos);
    CHECK(help.find("--sample-point") != std::string::npos);
    CHECK(help.find("--dsample-point") != std::string::npos);
  }

  argparse::ArgumentParser bench_parser("bench");
  ConfigureBenchCommand(bench_parser);
  CHECK(HelpOf(bench_parser).find("--dsample-point") != std::string::npos);

  argparse::ArgumentParser stress_parser("stress");
  ConfigureStressCommand(stress_parser);
  CHECK(HelpOf(stress_parser).find("--dsample-point") != std::string::npos);

  argparse::ArgumentParser play_parser("play");
  ConfigurePlayCommand(play_parser);
  const std::string play_help = HelpOf(play_parser);
  CHECK(play_help.find("--dsample-point") != std::string::npos);
  // play 仍然不支持 --canfd
  CHECK(play_help.find("--canfd") == std::string::npos);
}

TEST_CASE("Slave configuration help describes only the current platform's serial form") {
  const std::string help = motor_cli::SlaveConfigHelp();
  CHECK(help.find("Slave configuration targets:") != std::string::npos);
#if defined(_WIN32)
  CHECK(help.find("COM") != std::string::npos);
  CHECK(help.find("/dev/ttyACM0") == std::string::npos);
#else
  CHECK(help.find("/dev/ttyACM0") != std::string::npos);
  CHECK(help.find("COM") == std::string::npos);
#endif
}
