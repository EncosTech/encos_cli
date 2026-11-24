# SPDX-License-Identifier: MIT
#
# 构建期解析本地 encos_driver SDK（不联网）。
#
# 输入（在 include 本模块前设置）：
#   EMCLI_EXPECTED_DRIVER_VERSION  必填，例如 4.1.2
#   EMCLI_DRIVER_CMAKE_DIR         可选，包含 encos_driverConfig.cmake 的目录
#   EMCLI_DRIVER_PREFIX            可选，安装前缀
#   ENCOS_DRIVER_ROOT              可选，安装前缀（兼容驱动构建脚本）
#
# 输出：
#   EMCLI_DRIVER_VERSION
#   EMCLI_DRIVER_PREFIX
#   EMCLI_DRIVER_INCLUDE_DIRS
#   EMCLI_DRIVER_LIBRARY
#   EMCLI_DRIVER_SONAME
#   EMCLI_DRIVER_PLUGIN_DIR
#   EMCLI_DRIVER_TARGET            （Encos::encos_driver）

if(NOT EMCLI_EXPECTED_DRIVER_VERSION)
    message(FATAL_ERROR "EMCLI_EXPECTED_DRIVER_VERSION is required (for example 4.1.2)")
endif()

set(_emcli_driver_hints)
foreach(_prefix IN ITEMS "${EMCLI_DRIVER_PREFIX}" "${ENCOS_DRIVER_ROOT}")
    if(_prefix)
        list(APPEND _emcli_driver_hints "${_prefix}")
    endif()
endforeach()

if(EMCLI_DRIVER_CMAKE_DIR)
    set(encos_driver_DIR "${EMCLI_DRIVER_CMAKE_DIR}" CACHE PATH "encos_driver CMake config directory" FORCE)
endif()
find_package(encos_driver ${EMCLI_EXPECTED_DRIVER_VERSION} EXACT CONFIG REQUIRED
    HINTS ${_emcli_driver_hints}
    PATH_SUFFIXES lib/cmake/encos_driver lib64/cmake/encos_driver)

if(NOT TARGET Encos::encos_driver)
    message(FATAL_ERROR "encos_driver found but target Encos::encos_driver is missing")
endif()

# find_package 的版本变量名在不同 CMake 版本下可能是 encos_driver_VERSION；
# 同时解析 version 文件，保证 EXACT 校验结果可诊断。
set(_version_file "${encos_driver_DIR}/encos_driverConfigVersion.cmake")
if(EXISTS "${_version_file}")
    file(READ "${_version_file}" _version_text)
    string(REGEX MATCH "set\\(PACKAGE_VERSION \"([^\"]+)\"\\)" _version_match "${_version_text}")
    if(CMAKE_MATCH_1)
        set(EMCLI_DRIVER_VERSION "${CMAKE_MATCH_1}")
    endif()
endif()
if(NOT EMCLI_DRIVER_VERSION)
    set(EMCLI_DRIVER_VERSION "${encos_driver_VERSION}")
endif()
if(NOT EMCLI_DRIVER_VERSION)
    message(FATAL_ERROR "Cannot determine encos_driver version from ${encos_driver_DIR}")
endif()
if(NOT EMCLI_DRIVER_VERSION VERSION_EQUAL EMCLI_EXPECTED_DRIVER_VERSION)
    message(FATAL_ERROR
        "encos_driver version mismatch: expected ${EMCLI_EXPECTED_DRIVER_VERSION}, found ${EMCLI_DRIVER_VERSION} (${encos_driver_DIR}).\n"
        "Install the matching libencosdriver package or set EMCLI_DRIVER_CMAKE_DIR explicitly.")
endif()

get_target_property(EMCLI_DRIVER_INCLUDE_DIRS Encos::encos_driver INTERFACE_INCLUDE_DIRECTORIES)
get_target_property(_emcli_driver_type Encos::encos_driver TYPE)
if(NOT _emcli_driver_type)
    message(FATAL_ERROR "Encos::encos_driver has no TYPE property")
endif()

get_target_property(_emcli_driver_location Encos::encos_driver IMPORTED_LOCATION)
if(NOT _emcli_driver_location)
    foreach(_config IN ITEMS RELEASE RELWITHDEBINFO MINSIZEREL DEBUG NOCONFIG)
        get_target_property(_emcli_driver_location Encos::encos_driver IMPORTED_LOCATION_${_config})
        if(_emcli_driver_location)
            break()
        endif()
    endforeach()
endif()
if(NOT _emcli_driver_location)
    get_target_property(_emcli_driver_implib Encos::encos_driver IMPORTED_IMPLIB)
    if(_emcli_driver_implib)
        set(_emcli_driver_location "${_emcli_driver_implib}")
    endif()
endif()
if(NOT _emcli_driver_location)
    message(FATAL_ERROR "Encos::encos_driver has no IMPORTED_LOCATION; cannot verify the local library")
endif()

set(EMCLI_DRIVER_LIBRARY "${_emcli_driver_location}")
set(EMCLI_DRIVER_TARGET Encos::encos_driver)

# 前缀：<prefix>/lib/cmake/encos_driver 或构建树根。
if(encos_driver_DIR MATCHES "^(.*)/lib(64)?/cmake/encos_driver$")
    set(EMCLI_DRIVER_PREFIX "${CMAKE_MATCH_1}")
elseif(encos_driver_DIR MATCHES "^(.*)/cmake/encos_driver$")
    set(EMCLI_DRIVER_PREFIX "${CMAKE_MATCH_1}")
else()
    set(EMCLI_DRIVER_PREFIX "${encos_driver_DIR}")
endif()

# 头文件校验：安装布局为 include/encos/encos/encos_driver.h，
# 源码树为 include/encos/encos_driver.h。
set(_emcli_header_found FALSE)
foreach(_include IN LISTS EMCLI_DRIVER_INCLUDE_DIRS)
    if(EXISTS "${_include}/encos/encos_driver.h" OR EXISTS "${_include}/encos/encos/encos_driver.h")
        set(_emcli_header_found TRUE)
        break()
    endif()
endforeach()
if(NOT _emcli_header_found)
    message(FATAL_ERROR
        "encos/encos_driver.h not found under EMCLI_DRIVER_INCLUDE_DIRS=${EMCLI_DRIVER_INCLUDE_DIRS}.\n"
        "Point EMCLI_DRIVER_CMAKE_DIR at a complete local encos_driver SDK.")
endif()

if(WIN32)
    set(EMCLI_DRIVER_SONAME "encosdriver.dll")
elseif(APPLE)
    set(EMCLI_DRIVER_SONAME "libencosdriver.${EMCLI_DRIVER_VERSION}.dylib")
else()
    string(REGEX MATCH "^[0-9]+" _major "${EMCLI_DRIVER_VERSION}")
    set(EMCLI_DRIVER_SONAME "libencosdriver.so.${_major}")
endif()

set(EMCLI_DRIVER_PLUGIN_DIR "${EMCLI_DRIVER_PREFIX}/lib/encosPlugins")
if(NOT EXISTS "${EMCLI_DRIVER_PLUGIN_DIR}")
    set(EMCLI_DRIVER_PLUGIN_DIR "${encos_driver_DIR}/encosPlugins")
endif()

message(STATUS "emcli-native: encos_driver ${EMCLI_DRIVER_VERSION} (${EMCLI_DRIVER_LIBRARY})")
message(STATUS "emcli-native: driver SONAME ${EMCLI_DRIVER_SONAME}")
message(STATUS "emcli-native: driver plugin dir ${EMCLI_DRIVER_PLUGIN_DIR}")
